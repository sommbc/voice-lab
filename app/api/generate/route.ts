import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertFfmpegAvailable,
  DEFAULT_OUTPUT_FORMAT,
  getFileExtension,
  getMimeType,
  mergeAudioFiles,
  transcodeAudioFile,
  type OutputFormat
} from "@/lib/audio";
import { chunkText, prepareTextForSpeech, slugifyFilename } from "@/lib/text";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MISTRAL_SPEECH_ENDPOINT = "https://api.mistral.ai/v1/audio/speech";
const MISTRAL_MODEL = "voxtral-mini-tts-2603";
const SINGLE_PASS_TIMEOUT_MS = 180_000;
const SEGMENT_TIMEOUT_MS = 120_000;
const SHORT_SINGLE_PASS_MAX_WORDS = 300;
const INTERMEDIATE_SEGMENT_FORMAT: OutputFormat = "wav";

type ProgressStage =
  | "cleaning"
  | "segmenting"
  | "single-pass"
  | "generating"
  | "normalizing"
  | "merging"
  | "final-normalization"
  | "done";

type GenerationStrategy =
  | "narration-segmented"
  | "fallback-chunking"
  | "single-pass-experimental"
  | "single-pass-short"
  | "legacy-single-pass";

type StreamEvent =
  | {
      type: "progress";
      stage: ProgressStage;
      message: string;
      currentSegment?: number;
      totalSegments?: number;
    }
  | {
      type: "complete";
      filename: string;
      audioBase64: string;
      mimeType: string;
      outputFormat: OutputFormat;
      normalizationApplied: boolean;
      strategy: GenerationStrategy;
      totalSegments: number;
    }
  | {
      type: "error";
      message: string;
      segmentIndex?: number;
      totalSegments?: number;
    };

class GenerationFailure extends Error {
  chunkingWorth: boolean;

  constructor(message: string, options: { chunkingWorth?: boolean } = {}) {
    super(message);
    this.name = "GenerationFailure";
    this.chunkingWorth = options.chunkingWorth ?? false;
  }
}

export async function POST(request: Request): Promise<Response> {
  let payload: {
    title?: unknown;
    text?: unknown;
    voiceId?: unknown;
    narrationMode?: unknown;
    singlePassExperimental?: unknown;
    singlePassMode?: unknown;
    normalizationEnabled?: unknown;
    outputFormat?: unknown;
    debugForceSinglePassFailure?: unknown;
  };

  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const title = typeof payload.title === "string" ? payload.title : "";
  const text = typeof payload.text === "string" ? payload.text : "";
  const voiceId =
    typeof payload.voiceId === "string" && payload.voiceId.trim()
      ? payload.voiceId.trim()
      : (process.env.MISTRAL_VOICE_ID ?? "");
  const narrationMode = payload.narrationMode !== false;
  const singlePassExperimental =
    payload.singlePassExperimental === true ||
    (payload.singlePassMode === true && payload.singlePassExperimental !== false);
  const normalizationEnabled = payload.normalizationEnabled !== false;
  const outputFormat = payload.outputFormat === "wav" ? "wav" : DEFAULT_OUTPUT_FORMAT;
  const debugForceSinglePassFailure = payload.debugForceSinglePassFailure === true;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void runGeneration({
        controller,
        title,
        text,
        voiceId,
        narrationMode,
        singlePassExperimental,
        normalizationEnabled,
        outputFormat,
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
  narrationMode,
  singlePassExperimental,
  normalizationEnabled,
  outputFormat,
  debugForceSinglePassFailure
}: {
  controller: ReadableStreamDefaultController<Uint8Array>;
  title: string;
  text: string;
  voiceId: string;
  narrationMode: boolean;
  singlePassExperimental: boolean;
  normalizationEnabled: boolean;
  outputFormat: OutputFormat;
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

    validateEnvironment(voiceId);

    sendEvent({
      type: "progress",
      stage: "cleaning",
      message: "Cleaning text"
    });

    const preparedText = prepareTextForSpeech(text);

    if (!preparedText.cleanedText) {
      throw new Error("The cleaned text is empty. Paste longer plain-language content.");
    }

    const filename = `${slugifyFilename(title, "voiceover")}.${getFileExtension(outputFormat)}`;
    const shouldUseShortSinglePass =
      narrationMode && preparedText.wordCount <= SHORT_SINGLE_PASS_MAX_WORDS;

    if (shouldUseShortSinglePass) {
      const singlePassResult = await generateSinglePassResult({
        input: preparedText.cleanedText,
        voiceId,
        outputFormat,
        normalizationEnabled,
        sendEvent,
        debugForceSinglePassFailure,
        strategyLabel: "Narration Mode short-form single pass"
      });

      tempDirectoryPath = singlePassResult.tempDirectoryPath;

      sendEvent({
        type: "progress",
        stage: "done",
        message: "Done"
      });

      sendEvent({
        type: "complete",
        filename,
        audioBase64: singlePassResult.audioBuffer.toString("base64"),
        mimeType: getMimeType(outputFormat),
        outputFormat,
        normalizationApplied: normalizationEnabled,
        strategy: "single-pass-short",
        totalSegments: 1
      });
      return;
    }

    if (narrationMode && !singlePassExperimental) {
      const segmentedResult = await generateSegmentedSpeech({
        paragraphs: preparedText.paragraphs,
        voiceId,
        outputFormat,
        normalizationEnabled,
        sendEvent
      });

      tempDirectoryPath = segmentedResult.tempDirectoryPath;

      sendEvent({
        type: "progress",
        stage: "done",
        message: "Done"
      });

      sendEvent({
        type: "complete",
        filename,
        audioBase64: segmentedResult.audioBuffer.toString("base64"),
        mimeType: getMimeType(outputFormat),
        outputFormat,
        normalizationApplied: normalizationEnabled,
        strategy: "narration-segmented",
        totalSegments: segmentedResult.totalSegments
      });
      return;
    }

    try {
      const singlePassResult = await generateSinglePassResult({
        input: preparedText.cleanedText,
        voiceId,
        outputFormat,
        normalizationEnabled,
        sendEvent,
        debugForceSinglePassFailure,
        strategyLabel: narrationMode
          ? "Single-pass experimental: trying full document first"
          : "Narration Mode off: trying full document first"
      });

      tempDirectoryPath = singlePassResult.tempDirectoryPath;

      sendEvent({
        type: "progress",
        stage: "done",
        message: "Done"
      });

      sendEvent({
        type: "complete",
        filename,
        audioBase64: singlePassResult.audioBuffer.toString("base64"),
        mimeType: getMimeType(outputFormat),
        outputFormat,
        normalizationApplied: normalizationEnabled,
        strategy: narrationMode ? "single-pass-experimental" : "legacy-single-pass",
        totalSegments: 1
      });
      return;
    } catch (error) {
      const failure = toGenerationFailure(error);

      if (!failure.chunkingWorth) {
        throw failure;
      }

      sendEvent({
        type: "progress",
        stage: "segmenting",
        message: `Single-pass failed (${truncate(failure.message, 160)}). Preparing narration segments`
      });
    }

    const fallbackResult = await generateSegmentedSpeech({
      paragraphs: preparedText.paragraphs,
      voiceId,
      outputFormat,
      normalizationEnabled,
      sendEvent
    });

    tempDirectoryPath = fallbackResult.tempDirectoryPath;

    sendEvent({
      type: "progress",
      stage: "done",
      message: "Done"
    });

    sendEvent({
      type: "complete",
      filename,
      audioBase64: fallbackResult.audioBuffer.toString("base64"),
      mimeType: getMimeType(outputFormat),
      outputFormat,
      normalizationApplied: normalizationEnabled,
      strategy: "fallback-chunking",
      totalSegments: fallbackResult.totalSegments
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

function validateEnvironment(voiceId: string): void {
  if (!process.env.MISTRAL_API_KEY) {
    throw new Error("Missing required env var: MISTRAL_API_KEY");
  }

  if (!voiceId) {
    throw new Error("Missing voice ID. Pick a saved voice or set MISTRAL_VOICE_ID server-side.");
  }
}

async function generateSinglePassResult({
  input,
  voiceId,
  outputFormat,
  normalizationEnabled,
  sendEvent,
  debugForceSinglePassFailure,
  strategyLabel
}: {
  input: string;
  voiceId: string;
  outputFormat: OutputFormat;
  normalizationEnabled: boolean;
  sendEvent: (event: StreamEvent) => void;
  debugForceSinglePassFailure: boolean;
  strategyLabel: string;
}): Promise<{ audioBuffer: Buffer; tempDirectoryPath: string }> {
  sendEvent({
    type: "progress",
    stage: "single-pass",
    message: strategyLabel
  });

  const sourceFormat = normalizationEnabled ? INTERMEDIATE_SEGMENT_FORMAT : outputFormat;
  const audioBuffer = await generateSinglePassSpeech({
    input,
    voiceId,
    responseFormat: sourceFormat,
    debugForceSinglePassFailure
  });

  if (!normalizationEnabled) {
    return {
      audioBuffer,
      tempDirectoryPath: ""
    };
  }

  await assertFfmpegAvailable();

  const tempDirectoryPath = await mkdtemp(path.join(tmpdir(), "voiceover-"));
  const sourcePath = path.join(tempDirectoryPath, `single-pass-source.${getFileExtension(sourceFormat)}`);
  const outputPath = path.join(tempDirectoryPath, `single-pass-output.${getFileExtension(outputFormat)}`);

  await writeFile(sourcePath, audioBuffer);

  sendEvent({
    type: "progress",
    stage: "final-normalization",
    message: "Final normalization"
  });

  await transcodeAudioFile({
    inputPath: sourcePath,
    outputPath,
    outputFormat,
    applyLoudnorm: true
  });

  return {
    audioBuffer: await readFile(outputPath),
    tempDirectoryPath
  };
}

async function generateSinglePassSpeech({
  input,
  voiceId,
  responseFormat,
  debugForceSinglePassFailure
}: {
  input: string;
  voiceId: string;
  responseFormat: OutputFormat;
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
        response_format: responseFormat,
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

async function generateSegmentedSpeech({
  paragraphs,
  voiceId,
  outputFormat,
  normalizationEnabled,
  sendEvent
}: {
  paragraphs: Parameters<typeof chunkText>[0];
  voiceId: string;
  outputFormat: OutputFormat;
  normalizationEnabled: boolean;
  sendEvent: (event: StreamEvent) => void;
}): Promise<{
  audioBuffer: Buffer;
  totalSegments: number;
  tempDirectoryPath: string;
}> {
  const segments = chunkText(paragraphs);

  if (segments.length === 0) {
    throw new Error("No narration segments were created after cleaning.");
  }

  sendEvent({
    type: "progress",
    stage: "segmenting",
    message: `Preparing narration segments (${segments.length} total)`
  });

  const tempDirectoryPath = await mkdtemp(path.join(tmpdir(), "voiceover-"));
  const segmentPaths: string[] = [];

  try {
    await assertFfmpegAvailable();

    for (let index = 0; index < segments.length; index += 1) {
      const segmentNumber = index + 1;

      sendEvent({
        type: "progress",
        stage: "generating",
        message: `Generating segment ${segmentNumber} of ${segments.length}`,
        currentSegment: segmentNumber,
        totalSegments: segments.length
      });

      const audioBuffer = await generateSegmentSpeech({
        input: segments[index].text,
        voiceId,
        segmentNumber,
        totalSegments: segments.length
      });

      const rawSegmentPath = path.join(
        tempDirectoryPath,
        `segment-${String(segmentNumber).padStart(3, "0")}.wav`
      );

      await writeFile(rawSegmentPath, audioBuffer);

      if (!normalizationEnabled) {
        segmentPaths.push(rawSegmentPath);
        continue;
      }

      const normalizedSegmentPath = path.join(
        tempDirectoryPath,
        `segment-${String(segmentNumber).padStart(3, "0")}-normalized.wav`
      );

      sendEvent({
        type: "progress",
        stage: "normalizing",
        message: `Normalizing segment ${segmentNumber} of ${segments.length}`,
        currentSegment: segmentNumber,
        totalSegments: segments.length
      });

      await transcodeAudioFile({
        inputPath: rawSegmentPath,
        outputPath: normalizedSegmentPath,
        outputFormat: INTERMEDIATE_SEGMENT_FORMAT,
        applyLoudnorm: true
      });

      segmentPaths.push(normalizedSegmentPath);
    }

    let assembledPath = segmentPaths[0];

    if (segmentPaths.length > 1) {
      sendEvent({
        type: "progress",
        stage: "merging",
        message: "Merging audio"
      });

      assembledPath = path.join(tempDirectoryPath, "merged.wav");
      await mergeAudioFiles({
        inputPaths: segmentPaths,
        outputPath: assembledPath,
        copyAudio: true
      });
    }

    let deliverPath = assembledPath;

    if (normalizationEnabled) {
      deliverPath = path.join(
        tempDirectoryPath,
        `final-output.${getFileExtension(outputFormat)}`
      );

      sendEvent({
        type: "progress",
        stage: "final-normalization",
        message: "Final normalization"
      });

      await transcodeAudioFile({
        inputPath: assembledPath,
        outputPath: deliverPath,
        outputFormat,
        applyLoudnorm: true
      });
    } else if (outputFormat !== INTERMEDIATE_SEGMENT_FORMAT) {
      deliverPath = path.join(
        tempDirectoryPath,
        `final-output.${getFileExtension(outputFormat)}`
      );

      await transcodeAudioFile({
        inputPath: assembledPath,
        outputPath: deliverPath,
        outputFormat,
        applyLoudnorm: false
      });
    }

    return {
      audioBuffer: await readFile(deliverPath),
      totalSegments: segments.length,
      tempDirectoryPath
    };
  } catch (error) {
    await rm(tempDirectoryPath, { force: true, recursive: true });
    throw error;
  }
}

async function generateSegmentSpeech({
  input,
  voiceId,
  segmentNumber,
  totalSegments
}: {
  input: string;
  voiceId: string;
  segmentNumber: number;
  totalSegments: number;
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
        response_format: INTERMEDIATE_SEGMENT_FORMAT,
        stream: false
      }),
      signal: AbortSignal.timeout(SEGMENT_TIMEOUT_MS)
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(
        `Segment ${segmentNumber} of ${totalSegments} failed: request timed out after ${formatSeconds(SEGMENT_TIMEOUT_MS)} seconds.`
      );
    }

    throw new Error(
      `Segment ${segmentNumber} of ${totalSegments} failed before Mistral returned audio: ${describeUnknownError(error)}`
    );
  }

  if (!response.ok) {
    const errorBody = await response.text();
    const suffix = errorBody ? ` ${truncate(errorBody, 300)}` : "";
    throw new Error(
      `Segment ${segmentNumber} of ${totalSegments} failed: Mistral API returned ${response.status} ${response.statusText}.${suffix}`
    );
  }

  let audioBuffer: Buffer;

  try {
    audioBuffer = await parseAudioResponse(response);
  } catch (error) {
    throw new Error(
      `Segment ${segmentNumber} of ${totalSegments} failed: ${describeUnknownError(error)}`
    );
  }

  if (audioBuffer.length === 0) {
    throw new Error(
      `Segment ${segmentNumber} of ${totalSegments} failed: Mistral returned empty audio.`
    );
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

function truncate(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength)}...`;
}
