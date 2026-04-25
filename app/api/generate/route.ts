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
  masterAudioFile,
  mergeAudioFiles,
  persistAudioDebugArtifact,
  resolveMasteringStrategy,
  STANDARD_INTERMEDIATE_CHANNELS,
  STANDARD_INTERMEDIATE_SAMPLE_RATE,
  transcodeAudioFile,
  type MasteringStrategy,
  type OutputFormat,
  type VolumeBoost
} from "@/lib/audio";
import { parseMistralAudioResponse, postMistralSpeech } from "@/lib/mistral";
import { chunkText, prepareTextForSpeech, slugifyFilename } from "@/lib/text";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const SINGLE_PASS_TIMEOUT_MS = 180_000;
const SEGMENT_TIMEOUT_MS = 120_000;
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
  | "continuous-read"
  | "segmented-fallback"
  | "segmented-only";

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
    continuousRead?: unknown;
    fallbackToSegmented?: unknown;
    forceSegmentedMode?: unknown;
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
  const forceSegmentedMode = payload.forceSegmentedMode === true;
  const continuousRead = forceSegmentedMode ? false : payload.continuousRead !== false;
  const fallbackToSegmented = payload.fallbackToSegmented !== false;
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
        continuousRead,
        fallbackToSegmented,
        forceSegmentedMode,
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
  continuousRead,
  fallbackToSegmented,
  forceSegmentedMode,
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
  continuousRead: boolean;
  fallbackToSegmented: boolean;
  forceSegmentedMode: boolean;
  normalizationEnabled: boolean;
  volumeBoost: VolumeBoost;
  smoothJoins: boolean;
  outputFormat: OutputFormat;
  debugForceSinglePassFailure: boolean;
}): Promise<void> {
  const encoder = new TextEncoder();
  let tempDirectoryPath = "";
  const debugAudioEnabled = readBooleanEnv(process.env.VOICEOVER_DEBUG_AUDIO);
  const masteringStrategy = resolveMasteringStrategy(process.env.VOICEOVER_MASTERING_STRATEGY);
  const debugArtifactDirectoryPath = debugAudioEnabled
    ? await mkdtemp(path.join(tmpdir(), "voiceover-debug-"))
    : "";

  const sendEvent = (event: StreamEvent) => {
    controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
  };

  try {
    console.info(
      "[generation] config",
      JSON.stringify({
        debugAudioEnabled,
        masteringStrategy
      })
    );

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

    if (forceSegmentedMode || !continuousRead) {
      const segmentedResult = await generateSegmentedSpeech({
        paragraphs: preparedText.paragraphs,
        voiceId,
        outputFormat,
        normalizationEnabled,
        volumeBoost,
        smoothJoins,
        sendEvent,
        preparationMessage: "Preparing segmented generation",
        masteringStrategy,
        debugArtifactDirectoryPath: debugArtifactDirectoryPath || undefined
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
        strategy: "segmented-only",
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
        progressMessage: "Generating continuous read",
        masteringStrategy,
        debugArtifactDirectoryPath: debugArtifactDirectoryPath || undefined
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
        strategy: "continuous-read",
        totalSegments: 1
      });
      return;
    } catch (error) {
      const failure = toGenerationFailure(error);

      if (!fallbackToSegmented || !failure.chunkingWorth) {
        throw failure;
      }

      sendEvent({
        type: "progress",
        stage: "single-pass",
        message: "Continuous read failed. Falling back to segmented generation."
      });
    }

    const fallbackResult = await generateSegmentedSpeech({
      paragraphs: preparedText.paragraphs,
      voiceId,
      outputFormat,
      normalizationEnabled,
      volumeBoost,
      smoothJoins,
      sendEvent,
      preparationMessage: "Preparing segmented fallback",
      masteringStrategy,
      debugArtifactDirectoryPath: debugArtifactDirectoryPath || undefined
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
      strategy: "segmented-fallback",
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

    if (debugArtifactDirectoryPath) {
      console.info(
        "[audio-debug] session",
        JSON.stringify({
          path: debugArtifactDirectoryPath
        })
      );
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
  smoothJoins
}: {
  segmentPaths: string[];
  tempDirectoryPath: string;
  smoothJoins: boolean;
}): Promise<string[]> {
  if (!smoothJoins || segmentPaths.length < 2) {
    return segmentPaths;
  }

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
    message: "Merging audio"
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
      message: `Merging audio again with re-encoding (${truncate(concatFailureReason, 120)})`
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

async function persistSegmentedRawDebugArtifact({
  segmentPaths,
  tempDirectoryPath,
  debugArtifactDirectoryPath
}: {
  segmentPaths: string[];
  tempDirectoryPath: string;
  debugArtifactDirectoryPath: string;
}): Promise<void> {
  if (segmentPaths.length === 0) {
    return;
  }

  const debugRawPath = path.join(
    tempDirectoryPath,
    `debug-raw-mistral.${getFileExtension(INTERMEDIATE_SEGMENT_FORMAT)}`
  );

  try {
    await mergeAudioFiles({
      inputPaths: segmentPaths,
      outputPath: debugRawPath,
      outputFormat: INTERMEDIATE_SEGMENT_FORMAT,
      strategy: "copy"
    });
  } catch {
    await mergeAudioFiles({
      inputPaths: segmentPaths,
      outputPath: debugRawPath,
      outputFormat: INTERMEDIATE_SEGMENT_FORMAT,
      strategy: "reencode"
    });
  }

  await persistAudioDebugArtifact({
    sourcePath: debugRawPath,
    directoryPath: debugArtifactDirectoryPath,
    filename: `raw-mistral-output.${getFileExtension(INTERMEDIATE_SEGMENT_FORMAT)}`,
    note: "Concatenated segmented Mistral output before join smoothing and mastering."
  });
}

async function finalizeOutput({
  assembledPath,
  tempDirectoryPath,
  outputFormat,
  normalizationEnabled,
  volumeBoost,
  sendEvent,
  masteringStrategy,
  debugArtifactDirectoryPath
}: {
  assembledPath: string;
  tempDirectoryPath: string;
  outputFormat: OutputFormat;
  normalizationEnabled: boolean;
  volumeBoost: VolumeBoost;
  sendEvent: (event: StreamEvent) => void;
  masteringStrategy: MasteringStrategy;
  debugArtifactDirectoryPath?: string;
}): Promise<{
  deliverPath: string;
  normalizationApplied: boolean;
  normalizationFallbackUsed: boolean;
}> {
  const targetExtension = `.${getFileExtension(outputFormat)}`;
  const assembledMatchesOutput = path.extname(assembledPath).toLowerCase() === targetExtension;

  if (!normalizationEnabled) {
    if (assembledMatchesOutput) {
      console.info(
        "[mastering] final",
        JSON.stringify({
          volumeBoost,
          strategy: "raw-debug-only"
        })
      );

      if (debugArtifactDirectoryPath) {
        await persistAudioDebugArtifact({
          sourcePath: assembledPath,
          directoryPath: debugArtifactDirectoryPath,
          filename: `final-master-output.${getFileExtension(outputFormat)}`,
          note: "Delivered without mastering because normalization was disabled."
        });
      }

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

    console.info(
      "[mastering] final",
      JSON.stringify({
        volumeBoost,
        strategy: "raw-debug-only"
      })
    );

    if (debugArtifactDirectoryPath) {
      await persistAudioDebugArtifact({
        sourcePath: deliverPath,
        directoryPath: debugArtifactDirectoryPath,
        filename: `final-master-output.${getFileExtension(outputFormat)}`,
        note: "Delivered without mastering because normalization was disabled."
      });
    }

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
    message: "Mastering final audio"
  });

  try {
    await masterAudioFile({
      inputPath: assembledPath,
      outputPath: normalizedOutputPath,
      outputFormat,
      volumeBoost,
      strategy: masteringStrategy,
      debugArtifactDirectoryPath
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
        message: `Mastering final audio failed (${truncate(
          normalizationFailureReason,
          140
        )}). Using the unmastered audio instead`
      });

      if (debugArtifactDirectoryPath) {
        await persistAudioDebugArtifact({
          sourcePath: assembledPath,
          directoryPath: debugArtifactDirectoryPath,
          filename: `final-master-output.${getFileExtension(outputFormat)}`,
          note: "Delivered unmastered after mastering failed."
        });
      }

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
      message: `Mastering final audio failed (${truncate(
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

      if (debugArtifactDirectoryPath) {
        await persistAudioDebugArtifact({
          sourcePath: fallbackOutputPath,
          directoryPath: debugArtifactDirectoryPath,
          filename: `final-master-output.${getFileExtension(outputFormat)}`,
          note: "Delivered after mastering failed and the route retried without mastering."
        });
      }
    } catch (fallbackError) {
      throw new Error(
        `Mastering final audio failed: ${normalizationFailureReason}. Fallback export failed: ${extractErrorReason(
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
  progressMessage,
  masteringStrategy,
  debugArtifactDirectoryPath
}: {
  input: string;
  voiceId: string;
  outputFormat: OutputFormat;
  normalizationEnabled: boolean;
  volumeBoost: VolumeBoost;
  sendEvent: (event: StreamEvent) => void;
  debugForceSinglePassFailure: boolean;
  progressMessage: string;
  masteringStrategy: MasteringStrategy;
  debugArtifactDirectoryPath?: string;
}): Promise<{
  audioBuffer: Buffer;
  tempDirectoryPath: string;
  normalizationApplied: boolean;
  normalizationFallbackUsed: boolean;
}> {
  sendEvent({
    type: "progress",
    stage: "single-pass",
    message: progressMessage
  });

  const sourceFormat = normalizationEnabled ? INTERMEDIATE_SEGMENT_FORMAT : outputFormat;
  const audioBuffer = await generateSinglePassSpeech({
    input,
    voiceId,
    responseFormat: sourceFormat,
    debugForceSinglePassFailure
  });

  if (!normalizationEnabled && !debugArtifactDirectoryPath) {
    console.info(
      "[mastering] final",
      JSON.stringify({
        volumeBoost,
        strategy: "raw-debug-only"
      })
    );

    return {
      audioBuffer,
      tempDirectoryPath: "",
      normalizationApplied: false,
      normalizationFallbackUsed: false
    };
  }

  const tempDirectoryPath = await mkdtemp(path.join(tmpdir(), "voiceover-"));
  const sourcePath = path.join(tempDirectoryPath, `single-pass-source.${getFileExtension(sourceFormat)}`);

  await writeFile(sourcePath, audioBuffer);

  if (debugArtifactDirectoryPath) {
    await persistAudioDebugArtifact({
      sourcePath,
      directoryPath: debugArtifactDirectoryPath,
      filename: `raw-mistral-output.${getFileExtension(sourceFormat)}`,
      note: "Exact single-pass Mistral output before mastering."
    });
  }

  if (!normalizationEnabled) {
    console.info(
      "[mastering] final",
      JSON.stringify({
        volumeBoost,
        strategy: "raw-debug-only"
      })
    );

    if (debugArtifactDirectoryPath) {
      await persistAudioDebugArtifact({
        sourcePath,
        directoryPath: debugArtifactDirectoryPath,
        filename: `final-master-output.${getFileExtension(sourceFormat)}`,
        note: "Delivered without mastering because normalization was disabled."
      });
    }

    return {
      audioBuffer,
      tempDirectoryPath,
      normalizationApplied: false,
      normalizationFallbackUsed: false
    };
  }

  await assertFfmpegAvailable();

  const finalizedOutput = await finalizeOutput({
    assembledPath: sourcePath,
    tempDirectoryPath,
    outputFormat,
    normalizationEnabled,
    volumeBoost,
    sendEvent,
    masteringStrategy,
    debugArtifactDirectoryPath
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
    response = await postMistralSpeech({
      input,
      voiceId,
      responseFormat,
      timeoutMs: SINGLE_PASS_TIMEOUT_MS
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

  const audioBuffer = await parseRouteAudioResponse(response);

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
  sendEvent,
  preparationMessage,
  masteringStrategy,
  debugArtifactDirectoryPath
}: {
  paragraphs: Parameters<typeof chunkText>[0];
  voiceId: string;
  outputFormat: OutputFormat;
  normalizationEnabled: boolean;
  volumeBoost: VolumeBoost;
  smoothJoins: boolean;
  sendEvent: (event: StreamEvent) => void;
  preparationMessage: string;
  masteringStrategy: MasteringStrategy;
  debugArtifactDirectoryPath?: string;
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
    message: preparationMessage
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
      segmentPaths.push(rawSegmentPath);
    }

    if (debugArtifactDirectoryPath) {
      await persistSegmentedRawDebugArtifact({
        segmentPaths,
        tempDirectoryPath,
        debugArtifactDirectoryPath
      });
    }

    const joinReadyPaths = await prepareSegmentsForJoinSmoothing({
      segmentPaths,
      tempDirectoryPath,
      smoothJoins
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
      sendEvent,
      masteringStrategy,
      debugArtifactDirectoryPath
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
    response = await postMistralSpeech({
      input,
      voiceId,
      responseFormat: INTERMEDIATE_SEGMENT_FORMAT,
      timeoutMs: SEGMENT_TIMEOUT_MS
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
    audioBuffer = await parseRouteAudioResponse(response);
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

async function parseRouteAudioResponse(response: Response): Promise<Buffer> {
  try {
    return await parseMistralAudioResponse(response);
  } catch (error) {
    throw new GenerationFailure(describeUnknownError(error), {
      chunkingWorth: true
    });
  }
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

  if (status === 429 || status >= 500) {
    return true;
  }

  if (status === 401 || status === 403 || status === 404) {
    return false;
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
      return "Mastering final audio";
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
      /^(audio merge|final mastering|final normalization|join smoothing|segment normalization|speech pre-master|audio encoding|ffmpeg) failed:\s*/i,
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

function readBooleanEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? "");
}
