import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanText, chunkText, slugifyFilename } from "@/lib/text";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MISTRAL_SPEECH_ENDPOINT = "https://api.mistral.ai/v1/audio/speech";
const MISTRAL_MODEL = "voxtral-mini-tts-2603";
const SINGLE_PASS_TIMEOUT_MS = 180_000;
const CHUNK_TIMEOUT_MS = 120_000;

type ProgressStage = "cleaning" | "single-pass" | "chunking" | "generating" | "merging" | "done";
type GenerationMode = "single-pass" | "chunked";

type StreamEvent =
  | {
      type: "progress";
      stage: ProgressStage;
      message: string;
      currentChunk?: number;
      totalChunks?: number;
    }
  | {
      type: "complete";
      filename: string;
      audioBase64: string;
      totalChunks: number;
      mode: GenerationMode;
      usedFallbackChunking: boolean;
    }
  | {
      type: "error";
      message: string;
      chunkIndex?: number;
      totalChunks?: number;
    };

class GenerationFailure extends Error {
  chunkingWorth: boolean;

  constructor(message: string, options: { chunkingWorth?: boolean } = {}) {
    super(message);
    this.name = "GenerationFailure";
    this.chunkingWorth = options.chunkingWorth ?? false;
  }
}

let ffmpegReadyPromise: Promise<void> | null = null;

export async function POST(request: Request): Promise<Response> {
  let payload: {
    title?: unknown;
    text?: unknown;
    voiceId?: unknown;
    singlePassMode?: unknown;
    fallbackChunkingOnFailure?: unknown;
    debugForceSinglePassFailure?: unknown;
  };

  try {
    payload = (await request.json()) as {
      title?: unknown;
      text?: unknown;
      voiceId?: unknown;
      singlePassMode?: unknown;
      fallbackChunkingOnFailure?: unknown;
      debugForceSinglePassFailure?: unknown;
    };
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const title = typeof payload.title === "string" ? payload.title : "";
  const text = typeof payload.text === "string" ? payload.text : "";
  const voiceId =
    typeof payload.voiceId === "string" && payload.voiceId.trim()
      ? payload.voiceId.trim()
      : (process.env.MISTRAL_VOICE_ID ?? "");
  const singlePassMode = payload.singlePassMode !== false;
  const fallbackChunkingOnFailure = payload.fallbackChunkingOnFailure !== false;
  const debugForceSinglePassFailure = payload.debugForceSinglePassFailure === true;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void runGeneration({
        controller,
        title,
        text,
        voiceId,
        singlePassMode,
        fallbackChunkingOnFailure,
        debugForceSinglePassFailure
      });
    }
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "Content-Type": "application/x-ndjson; charset=utf-8"
    }
  });
}

async function runGeneration({
  controller,
  title,
  text,
  voiceId,
  singlePassMode,
  fallbackChunkingOnFailure,
  debugForceSinglePassFailure
}: {
  controller: ReadableStreamDefaultController<Uint8Array>;
  title: string;
  text: string;
  voiceId: string;
  singlePassMode: boolean;
  fallbackChunkingOnFailure: boolean;
  debugForceSinglePassFailure: boolean;
}): Promise<void> {
  const encoder = new TextEncoder();
  let tempDirectoryPath = "";

  const sendEvent = (event: StreamEvent) => {
    controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
  };

  try {
    if (!text.trim()) {
      throw new Error("Paste some text before generating audio.");
    }

    validateEnvironment();

    sendEvent({
      type: "progress",
      stage: "cleaning",
      message: "Cleaning text"
    });

    const cleanedText = cleanText(text);

    if (!cleanedText) {
      throw new Error("The cleaned text is empty. Paste longer plain-language content.");
    }

    const filename = `${slugifyFilename(title, "voiceover")}.mp3`;

    if (singlePassMode) {
      sendEvent({
        type: "progress",
        stage: "single-pass",
        message: "Generating full document in single-pass mode"
      });

      try {
        const audioBuffer = await generateSinglePassSpeech({
          input: cleanedText,
          voiceId,
          debugForceSinglePassFailure
        });

        sendEvent({
          type: "progress",
          stage: "done",
          message: "Done"
        });

        sendEvent({
          type: "complete",
          filename,
          audioBase64: audioBuffer.toString("base64"),
          totalChunks: 1,
          mode: "single-pass",
          usedFallbackChunking: false
        });
        return;
      } catch (error) {
        const failure = toGenerationFailure(error);

        if (!fallbackChunkingOnFailure || !failure.chunkingWorth) {
          throw failure;
        }

        sendEvent({
          type: "progress",
          stage: "chunking",
          message: `Single-pass failed (${truncate(failure.message, 160)}). Falling back to chunking`
        });
      }
    } else {
      sendEvent({
        type: "progress",
        stage: "chunking",
        message: "Single-pass disabled. Chunking text before generation"
      });
    }

    const chunkedResult = await generateChunkedSpeech({
      cleanedText,
      voiceId,
      sendEvent
    });

    tempDirectoryPath = chunkedResult.tempDirectoryPath;

    sendEvent({
      type: "progress",
      stage: "done",
      message: "Done"
    });

    sendEvent({
      type: "complete",
      filename,
      audioBase64: chunkedResult.audioBase64,
      totalChunks: chunkedResult.totalChunks,
      mode: "chunked",
      usedFallbackChunking: singlePassMode
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error during generation.";

    sendEvent({
      type: "error",
      message
    });
  } finally {
    controller.close();

    if (tempDirectoryPath) {
      await rm(tempDirectoryPath, { force: true, recursive: true });
    }
  }
}

function validateEnvironment(): void {
  if (!process.env.MISTRAL_API_KEY) {
    throw new Error("Missing required env var: MISTRAL_API_KEY");
  }
}

async function generateSinglePassSpeech({
  input,
  voiceId,
  debugForceSinglePassFailure
}: {
  input: string;
  voiceId: string;
  debugForceSinglePassFailure: boolean;
}): Promise<Buffer> {
  if (debugForceSinglePassFailure) {
    throw new GenerationFailure("Single-pass failure forced for local fallback verification.", {
      chunkingWorth: true
    });
  }

  let response: Response;

  try {
    response = await fetch(MISTRAL_SPEECH_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        input,
        voice_id: voiceId,
        response_format: "mp3",
        stream: false
      }),
      signal: AbortSignal.timeout(SINGLE_PASS_TIMEOUT_MS)
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new GenerationFailure(
        `Single-pass request timed out after ${formatSeconds(SINGLE_PASS_TIMEOUT_MS)} seconds.`,
        { chunkingWorth: true }
      );
    }

    throw new GenerationFailure(
      `Single-pass request failed before Mistral returned audio: ${describeUnknownError(error)}`
    );
  }

  if (!response.ok) {
    const errorBody = await response.text();
    const suffix = errorBody ? ` ${truncate(errorBody, 300)}` : "";
    throw new GenerationFailure(
      `Single-pass request failed: Mistral API returned ${response.status} ${response.statusText}.${suffix}`,
      { chunkingWorth: isChunkingWorthyApiFailure(response.status, errorBody) }
    );
  }

  const audioBuffer = await parseAudioResponse(response);

  if (audioBuffer.length === 0) {
    throw new GenerationFailure("Single-pass request returned empty audio.", {
      chunkingWorth: true
    });
  }

  return audioBuffer;
}

async function generateChunkedSpeech({
  cleanedText,
  voiceId,
  sendEvent
}: {
  cleanedText: string;
  voiceId: string;
  sendEvent: (event: StreamEvent) => void;
}): Promise<{
  audioBase64: string;
  totalChunks: number;
  tempDirectoryPath: string;
}> {
  const chunks = chunkText(cleanedText);

  if (chunks.length === 0) {
    throw new Error("No fallback speech chunks were created after cleaning.");
  }

  sendEvent({
    type: "progress",
    stage: "chunking",
    message: `Chunking text into ${chunks.length} part${chunks.length === 1 ? "" : "s"}`
  });

  const tempDirectoryPath = await mkdtemp(path.join(tmpdir(), "voiceover-"));
  const chunkPaths: string[] = [];
  const chunkBuffers: Buffer[] = [];

  try {
    if (chunks.length > 1) {
      await assertFfmpegAvailable();
    }

    for (let index = 0; index < chunks.length; index += 1) {
      const chunkNumber = index + 1;
      sendEvent({
        type: "progress",
        stage: "generating",
        message: `Generating chunk ${chunkNumber} of ${chunks.length}`,
        currentChunk: chunkNumber,
        totalChunks: chunks.length
      });

      const audioBuffer = await generateChunkSpeech({
        input: chunks[index].text,
        voiceId,
        chunkNumber,
        totalChunks: chunks.length
      });

      chunkBuffers.push(audioBuffer);

      const chunkPath = path.join(
        tempDirectoryPath,
        `chunk-${String(chunkNumber).padStart(3, "0")}.mp3`
      );

      await writeFile(chunkPath, audioBuffer);
      chunkPaths.push(chunkPath);
    }

    if (chunkBuffers.length === 1) {
      return {
        audioBase64: chunkBuffers[0].toString("base64"),
        totalChunks: 1,
        tempDirectoryPath
      };
    }

    sendEvent({
      type: "progress",
      stage: "merging",
      message: "Merging chunk MP3s"
    });

    const mergedOutputPath = path.join(tempDirectoryPath, "merged-output.mp3");
    await mergeChunkFiles(chunkPaths, mergedOutputPath);

    return {
      audioBase64: (await readFile(mergedOutputPath)).toString("base64"),
      totalChunks: chunks.length,
      tempDirectoryPath
    };
  } catch (error) {
    await rm(tempDirectoryPath, { force: true, recursive: true });
    throw error;
  }
}

async function assertFfmpegAvailable(): Promise<void> {
  if (!ffmpegReadyPromise) {
    ffmpegReadyPromise = new Promise((resolve, reject) => {
      const process = spawn("ffmpeg", ["-version"]);

      process.once("error", () => {
        reject(
          new Error(
            "ffmpeg is not installed or not available on PATH. On macOS: brew install ffmpeg"
          )
        );
      });

      process.once("exit", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error("ffmpeg is installed but did not start cleanly."));
      });
    });
  }

  await ffmpegReadyPromise;
}

async function generateChunkSpeech({
  input,
  voiceId,
  chunkNumber,
  totalChunks
}: {
  input: string;
  voiceId: string;
  chunkNumber: number;
  totalChunks: number;
}): Promise<Buffer> {
  let response: Response;

  try {
    response = await fetch(MISTRAL_SPEECH_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        input,
        voice_id: voiceId,
        response_format: "mp3",
        stream: false
      }),
      signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS)
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(
        `Chunk ${chunkNumber} of ${totalChunks} failed: request timed out after ${formatSeconds(CHUNK_TIMEOUT_MS)} seconds.`
      );
    }

    throw new Error(
      `Chunk ${chunkNumber} of ${totalChunks} failed before Mistral returned audio: ${describeUnknownError(error)}`
    );
  }

  if (!response.ok) {
    const errorBody = await response.text();
    const suffix = errorBody ? ` ${truncate(errorBody, 300)}` : "";
    throw new Error(
      `Chunk ${chunkNumber} of ${totalChunks} failed: Mistral API returned ${response.status} ${response.statusText}.${suffix}`
    );
  }

  let audioBuffer: Buffer;

  try {
    audioBuffer = await parseAudioResponse(response);
  } catch (error) {
    throw new Error(
      `Chunk ${chunkNumber} of ${totalChunks} failed: ${describeUnknownError(error)}`
    );
  }

  if (audioBuffer.length === 0) {
    throw new Error(`Chunk ${chunkNumber} of ${totalChunks} failed: Mistral returned empty audio.`);
  }

  return audioBuffer;
}

async function parseAudioResponse(response: Response): Promise<Buffer> {
  let data: { audio_data?: string };

  try {
    data = (await response.json()) as { audio_data?: string };
  } catch {
    throw new GenerationFailure("Mistral API response was not valid JSON.", {
      chunkingWorth: true
    });
  }

  if (!data.audio_data) {
    throw new GenerationFailure("Mistral API response did not include audio_data.", {
      chunkingWorth: true
    });
  }

  return Buffer.from(data.audio_data, "base64");
}

async function mergeChunkFiles(chunkPaths: string[], outputPath: string): Promise<void> {
  const listFilePath = path.join(path.dirname(outputPath), `concat-${randomUUID()}.txt`);
  const concatList = chunkPaths
    .map((chunkPath) => `file '${escapeForFfmpegConcat(chunkPath)}'`)
    .join("\n");

  await writeFile(listFilePath, concatList);

  try {
    await runFfmpeg([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFilePath,
      "-vn",
      "-acodec",
      "libmp3lame",
      "-b:a",
      "192k",
      outputPath
    ]);

    const outputStats = await stat(outputPath);
    if (outputStats.size === 0) {
      throw new Error("ffmpeg created an empty output file.");
    }
  } finally {
    await rm(listFilePath, { force: true });
  }
}

async function runFfmpeg(argumentsList: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ffmpegProcess = spawn("ffmpeg", argumentsList, {
      stdio: ["ignore", "ignore", "pipe"]
    });

    let stderr = "";

    ffmpegProcess.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    ffmpegProcess.once("error", () => {
      reject(
        new Error(
          "ffmpeg is not installed or not available on PATH. On macOS: brew install ffmpeg"
        )
      );
    });

    ffmpegProcess.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg failed while merging MP3 chunks. ${truncate(stderr, 400)}`));
    });
  });
}

function toGenerationFailure(error: unknown): GenerationFailure {
  if (error instanceof GenerationFailure) {
    return error;
  }

  if (error instanceof Error) {
    return new GenerationFailure(error.message);
  }

  return new GenerationFailure("Unexpected error during generation.");
}

function isChunkingWorthyApiFailure(status: number, errorBody: string): boolean {
  if (status === 408 || status === 413 || status === 422) {
    return true;
  }

  if (status !== 400) {
    return false;
  }

  return /\b(input|text|prompt|length|too\s+long|too\s+large|max(?:imum)?|limit|character|token|size|payload)\b/i.test(
    errorBody
  );
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      /timed? out|aborted due to timeout/i.test(error.message))
  );
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error.";
}

function formatSeconds(milliseconds: number): number {
  return Math.round(milliseconds / 1000);
}

function escapeForFfmpegConcat(filePath: string): string {
  return filePath.replace(/'/g, "'\\''");
}

function truncate(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength)}...`;
}
