import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AudioProcessingError,
  assertFfmpegAvailable,
  DEFAULT_JOIN_PAUSE_MS,
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_SMOOTH_JOINS,
  DEFAULT_VOLUME_BOOST,
  getFileExtension,
  getMimeType,
  generateSilenceAudioFile,
  mergeAudioFiles,
  STANDARD_INTERMEDIATE_CHANNELS,
  STANDARD_INTERMEDIATE_SAMPLE_RATE,
  transcodeAudioFile,
  type OutputFormat,
  type VolumeBoost
} from "@/lib/audio";
import { chunkText, prepareTextForSpeech, slugifyFilename } from "@/lib/text";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

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
  | "smoothing"
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
      normalizationFallbackUsed: boolean;
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
    volumeBoost?: unknown;
    smoothJoins?: unknown;
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
  const volumeBoost =
    payload.volumeBoost === "normal" ||
    payload.volumeBoost === "louder" ||
    payload.volumeBoost === "very-loud"
      ? payload.volumeBoost
      : DEFAULT_VOLUME_BOOST;
  const smoothJoins = payload.smoothJoins === false ? false : DEFAULT_SMOOTH_JOINS;
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
        volumeBoost,
        smoothJoins,
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
  volumeBoost,
  smoothJoins,
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
  volumeBoost: VolumeBoost;
  smoothJoins: boolean;
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
      message: "Preparing narration"
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
        volumeBoost,
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
        normalizationApplied: singlePassResult.normalizationApplied,
        normalizationFallbackUsed: singlePassResult.normalizationFallbackUsed,
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
        volumeBoost,
        smoothJoins,
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
        normalizationApplied: segmentedResult.normalizationApplied,
        normalizationFallbackUsed: segmentedResult.normalizationFallbackUsed,
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
        volumeBoost,
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
        normalizationApplied: singlePassResult.normalizationApplied,
        normalizationFallbackUsed: singlePassResult.normalizationFallbackUsed,
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
      volumeBoost,
      smoothJoins,
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
      normalizationApplied: fallbackResult.normalizationApplied,
      normalizationFallbackUsed: fallbackResult.normalizationFallbackUsed,
      strategy: "fallback-chunking",
      totalSegments: fallbackResult.totalSegments
    });
  } catch (error) {
    sendEvent({
      type: "error",
      message: describeSafeError(error)
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

async function prepareSegmentsForJoinSmoothing({
  segmentPaths,
  tempDirectoryPath,
  smoothJoins,
  sendEvent
}: {
  segmentPaths: string[];
  tempDirectoryPath: string;
  smoothJoins: boolean;
  sendEvent: (event: StreamEvent) => void;
}): Promise<string[]> {
  if (!smoothJoins || segmentPaths.length < 2) {
    return segmentPaths;
  }

  sendEvent({
    type: "progress",
    stage: "smoothing",
    message: "Smoothing joins"
  });

  const joinGapPath = path.join(tempDirectoryPath, "join-gap.wav");

  await generateSilenceAudioFile({
    outputPath: joinGapPath,
    durationMs: DEFAULT_JOIN_PAUSE_MS,
    sampleRate: STANDARD_INTERMEDIATE_SAMPLE_RATE,
    channels: STANDARD_INTERMEDIATE_CHANNELS
  });

  const smoothedPaths: string[] = [];

  for (let index = 0; index < segmentPaths.length; index += 1) {
    const smoothedSegmentPath = path.join(
      tempDirectoryPath,
      `segment-${String(index + 1).padStart(3, "0")}-smoothed.wav`
    );

    try {
      await transcodeAudioFile({
        inputPath: segmentPaths[index],
        outputPath: smoothedSegmentPath,
        outputFormat: INTERMEDIATE_SEGMENT_FORMAT,
        applyLoudnorm: false,
        trimSilence: true,
        sampleRate: STANDARD_INTERMEDIATE_SAMPLE_RATE,
        channels: STANDARD_INTERMEDIATE_CHANNELS,
        stage: "join-smoothing"
      });
    } catch (error) {
      throw new Error(`Join smoothing failed on section ${index + 1}: ${extractErrorReason(error)}`);
    }

    smoothedPaths.push(smoothedSegmentPath);

    if (index < segmentPaths.length - 1) {
      smoothedPaths.push(joinGapPath);
    }
  }

  return smoothedPaths;
}

async function mergeSegmentsWithFallback({
  segmentPaths,
  tempDirectoryPath,
  outputFormat,
  sendEvent
}: {
  segmentPaths: string[];
  tempDirectoryPath: string;
  outputFormat: OutputFormat;
  sendEvent: (event: StreamEvent) => void;
}): Promise<string> {
  if (segmentPaths.length === 1) {
    return segmentPaths[0];
  }

  sendEvent({
    type: "progress",
    stage: "merging",
    message: "Joining sections"
  });

  const copyMergedPath = path.join(tempDirectoryPath, "merged.wav");

  try {
    await mergeAudioFiles({
      inputPaths: segmentPaths,
      outputPath: copyMergedPath,
      outputFormat: INTERMEDIATE_SEGMENT_FORMAT,
      strategy: "copy"
    });

    return copyMergedPath;
  } catch (error) {
    const concatFailureReason = extractErrorReason(error);
    const fallbackFormat = outputFormat === "mp3" ? "mp3" : INTERMEDIATE_SEGMENT_FORMAT;
    const fallbackMergedPath = path.join(
      tempDirectoryPath,
      `merged-reencoded.${getFileExtension(fallbackFormat)}`
    );

    sendEvent({
      type: "progress",
      stage: "merging",
      message: `Concat copy failed (${truncate(concatFailureReason, 140)}). Retrying with re-encoding`
    });

    try {
      await mergeAudioFiles({
        inputPaths: segmentPaths,
        outputPath: fallbackMergedPath,
        outputFormat: fallbackFormat,
        strategy: "reencode"
      });
    } catch (fallbackError) {
      throw new Error(
        `Audio merge failed: ${concatFailureReason}. Re-encode retry failed: ${extractErrorReason(
          fallbackError
        )}`
      );
    }

    return fallbackMergedPath;
  }
}

async function finalizeOutput({
  assembledPath,
  tempDirectoryPath,
  outputFormat,
  normalizationEnabled,
  volumeBoost,
  sendEvent
}: {
  assembledPath: string;
  tempDirectoryPath: string;
  outputFormat: OutputFormat;
  normalizationEnabled: boolean;
  volumeBoost: VolumeBoost;
  sendEvent: (event: StreamEvent) => void;
}): Promise<{
  deliverPath: string;
  normalizationApplied: boolean;
  normalizationFallbackUsed: boolean;
}> {
  const targetExtension = `.${getFileExtension(outputFormat)}`;
  const assembledMatchesOutput = path.extname(assembledPath).toLowerCase() === targetExtension;

  if (!normalizationEnabled) {
    if (assembledMatchesOutput) {
      return {
        deliverPath: assembledPath,
        normalizationApplied: false,
        normalizationFallbackUsed: false
      };
    }

    const deliverPath = path.join(tempDirectoryPath, `final-output.${getFileExtension(outputFormat)}`);

    await transcodeAudioFile({
      inputPath: assembledPath,
      outputPath: deliverPath,
      outputFormat,
      applyLoudnorm: false,
      stage: "encoding"
    });

    return {
      deliverPath,
      normalizationApplied: false,
      normalizationFallbackUsed: false
    };
  }

  const normalizedOutputPath = path.join(
    tempDirectoryPath,
    `final-output.${getFileExtension(outputFormat)}`
  );

  sendEvent({
    type: "progress",
    stage: "final-normalization",
    message: "Final mastering"
  });

  try {
    await transcodeAudioFile({
      inputPath: assembledPath,
      outputPath: normalizedOutputPath,
      outputFormat,
      applyLoudnorm: true,
      volumeBoost,
      stage: "final-normalization"
    });

    return {
      deliverPath: normalizedOutputPath,
      normalizationApplied: true,
      normalizationFallbackUsed: false
    };
  } catch (error) {
    const normalizationFailureReason = extractErrorReason(error);

    if (assembledMatchesOutput) {
      sendEvent({
        type: "progress",
        stage: "final-normalization",
        message: `Final mastering failed (${truncate(
          normalizationFailureReason,
          140
        )}). Using merged audio without mastering`
      });

      return {
        deliverPath: assembledPath,
        normalizationApplied: false,
        normalizationFallbackUsed: true
      };
    }

    const fallbackOutputPath = path.join(
      tempDirectoryPath,
      `final-output-fallback.${getFileExtension(outputFormat)}`
    );

    sendEvent({
      type: "progress",
      stage: "final-normalization",
      message: `Final mastering failed (${truncate(
        normalizationFailureReason,
        140
      )}). Retrying without mastering`
    });

    try {
      await transcodeAudioFile({
        inputPath: assembledPath,
        outputPath: fallbackOutputPath,
        outputFormat,
        applyLoudnorm: false,
        stage: "encoding"
      });
    } catch (fallbackError) {
      throw new Error(
        `Final normalization failed: ${normalizationFailureReason}. Fallback export failed: ${extractErrorReason(
          fallbackError
        )}`
      );
    }

    return {
      deliverPath: fallbackOutputPath,
      normalizationApplied: false,
      normalizationFallbackUsed: true
    };
  }
}

async function generateSinglePassResult({
  input,
  voiceId,
  outputFormat,
  normalizationEnabled,
  volumeBoost,
  sendEvent,
  debugForceSinglePassFailure,
  strategyLabel
}: {
  input: string;
  voiceId: string;
  outputFormat: OutputFormat;
  normalizationEnabled: boolean;
  volumeBoost: VolumeBoost;
  sendEvent: (event: StreamEvent) => void;
  debugForceSinglePassFailure: boolean;
  strategyLabel: string;
}): Promise<{
  audioBuffer: Buffer;
  tempDirectoryPath: string;
  normalizationApplied: boolean;
  normalizationFallbackUsed: boolean;
}> {
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
      tempDirectoryPath: "",
      normalizationApplied: false,
      normalizationFallbackUsed: false
    };
  }

  await assertFfmpegAvailable();

  const tempDirectoryPath = await mkdtemp(path.join(tmpdir(), "voiceover-"));
  const sourcePath = path.join(tempDirectoryPath, `single-pass-source.${getFileExtension(sourceFormat)}`);

  await writeFile(sourcePath, audioBuffer);

  const finalizedOutput = await finalizeOutput({
    assembledPath: sourcePath,
    tempDirectoryPath,
    outputFormat,
    normalizationEnabled,
    volumeBoost,
    sendEvent
  });

  return {
    audioBuffer: await readFile(finalizedOutput.deliverPath),
    tempDirectoryPath,
    normalizationApplied: finalizedOutput.normalizationApplied,
    normalizationFallbackUsed: finalizedOutput.normalizationFallbackUsed
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
  volumeBoost,
  smoothJoins,
  sendEvent
}: {
  paragraphs: Parameters<typeof chunkText>[0];
  voiceId: string;
  outputFormat: OutputFormat;
  normalizationEnabled: boolean;
  volumeBoost: VolumeBoost;
  smoothJoins: boolean;
  sendEvent: (event: StreamEvent) => void;
}): Promise<{
  audioBuffer: Buffer;
  totalSegments: number;
  tempDirectoryPath: string;
  normalizationApplied: boolean;
  normalizationFallbackUsed: boolean;
}> {
  const segments = chunkText(paragraphs);

  if (segments.length === 0) {
    throw new Error("No narration segments were created after cleaning.");
  }

  sendEvent({
    type: "progress",
    stage: "segmenting",
    message: "Preparing narration"
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
        message: `Generating section ${segmentNumber} of ${segments.length}`,
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
        message: `Normalizing section ${segmentNumber} of ${segments.length}`,
        currentSegment: segmentNumber,
        totalSegments: segments.length
      });

      try {
        await transcodeAudioFile({
          inputPath: rawSegmentPath,
          outputPath: normalizedSegmentPath,
          outputFormat: INTERMEDIATE_SEGMENT_FORMAT,
          applyLoudnorm: true,
          volumeBoost: "normal",
          sampleRate: STANDARD_INTERMEDIATE_SAMPLE_RATE,
          channels: STANDARD_INTERMEDIATE_CHANNELS,
          stage: "segment-normalization"
        });
      } catch (error) {
        throw new Error(
          `Segment ${segmentNumber} of ${segments.length} normalization failed: ${extractErrorReason(error)}`
        );
      }

      segmentPaths.push(normalizedSegmentPath);
    }

    const joinReadyPaths = await prepareSegmentsForJoinSmoothing({
      segmentPaths,
      tempDirectoryPath,
      smoothJoins,
      sendEvent
    });

    const assembledPath = await mergeSegmentsWithFallback({
      segmentPaths: joinReadyPaths,
      tempDirectoryPath,
      outputFormat,
      sendEvent
    });

    const finalizedOutput = await finalizeOutput({
      assembledPath,
      tempDirectoryPath,
      outputFormat,
      normalizationEnabled,
      volumeBoost,
      sendEvent
    });

    return {
      audioBuffer: await readFile(finalizedOutput.deliverPath),
      totalSegments: segments.length,
      tempDirectoryPath,
      normalizationApplied: finalizedOutput.normalizationApplied,
      normalizationFallbackUsed: finalizedOutput.normalizationFallbackUsed
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

function describeSafeError(error: unknown): string {
  if (error instanceof AudioProcessingError) {
    return `${formatAudioStageLabel(error.stage)} failed: ${extractErrorReason(error)}`;
  }

  if (error instanceof Error) {
    return sanitizeErrorMessage(error.message);
  }

  return "Unexpected error during generation.";
}

function extractErrorReason(error: unknown): string {
  const rawMessage =
    error instanceof AudioProcessingError
      ? error.stderrSummary || error.message
      : error instanceof Error
        ? error.message
        : "Unknown error.";

  return stripAudioFailurePrefix(sanitizeErrorMessage(rawMessage));
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

function formatAudioStageLabel(stage: AudioProcessingError["stage"]): string {
  switch (stage) {
    case "segment-normalization":
      return "Segment normalization";
    case "final-normalization":
      return "Final mastering";
    case "join-smoothing":
      return "Join smoothing";
    case "merge":
      return "Audio merge";
    case "encoding":
      return "Audio encoding";
    case "availability-check":
    default:
      return "ffmpeg";
  }
}

function stripAudioFailurePrefix(message: string): string {
  return message
    .replace(
      /^(audio merge|final mastering|final normalization|join smoothing|segment normalization|audio encoding|ffmpeg) failed:\s*/i,
      ""
    )
    .trim();
}

function sanitizeErrorMessage(message: string): string {
  const cleaned = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !/^ffmpeg version /i.test(line) &&
        !/^built with /i.test(line) &&
        !/^configuration:/i.test(line) &&
        !/^libav[a-z]+\s+/i.test(line)
    )
    .join(" ");

  return truncate(cleaned || message, 280);
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
