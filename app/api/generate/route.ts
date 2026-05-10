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
  VOLUME_BOOST_SETTINGS,
  buildSegmentJoinPlan,
  buildSegmentBoundaryDiagnostics,
  buildSegmentSeamAdjustmentFilter,
  buildMultiTakePairwiseSeamScoreMatrix,
  collectSegmentDiagnosticsWarnings,
  computeMultiTakeCandidatePenalty,
  computeSegmentSeamAdjustments,
  evaluateSegmentedPublishability,
  extractAudioClip,
  getFileExtension,
  getMimeType,
  generateSilenceAudioFile,
  levelSegmentAudioFile,
  masterAudioFile,
  measureSegmentAudioFile,
  mergeAudioFiles,
  persistAudioDebugArtifact,
  resolveMasteringStrategy,
  resolveMultiTakeCount,
  selectAcousticTrimPoint,
  selectSeamRegenerationTargets,
  selectBestMultiTakePath,
  SEGMENT_LEVELING_SETTINGS,
  STANDARD_INTERMEDIATE_CHANNELS,
  STANDARD_INTERMEDIATE_SAMPLE_RATE,
  standardizeSegmentAudioFile,
  applySegmentSeamAdjustmentAudioFile,
  transcodeAudioFile,
  type AudioMasteringResult,
  type MasteringStrategy,
  type OutputFormat,
  type SegmentBoundaryDiagnostic,
  type SegmentDiagnosticsManifest,
  type SegmentDiagnosticsManifestSegment,
  type SegmentDiagnosticsWarning,
  type SegmentJoinPlan,
  type MultiTakeCandidateInput,
  type MultiTakeCandidateManifest,
  type MultiTakeOptimizationManifest,
  type MultiTakePathSelection,
  type VolumeBoost
} from "@/lib/audio";
import {
  parseMistralAudioResponse,
  postMistralSpeech,
  resolveMistralProviderConfig
} from "@/lib/providers/mistral";
import {
  buildSegmentContinuityPrompt,
  chunkText,
  extractFirstSentences,
  extractLastSentences,
  prepareTextForSpeech,
  repairChunkBoundary,
  slugifyFilename,
  type ChunkBoundaryRepair,
  type SegmentContinuityPrompt,
  type TextChunk
} from "@/lib/text";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const SINGLE_PASS_TIMEOUT_MS = 180_000;
const SEGMENT_TIMEOUT_MS = 120_000;
const INTERMEDIATE_SEGMENT_FORMAT: OutputFormat = "wav";
const MAX_SEAM_REGENERATION_SEGMENTS = 2;
const DEFAULT_SEAM_RETRY_COUNT = 2;

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

type ProcessedSegment = {
  rawSegmentPath: string;
  standardizedSegmentPath: string;
  leveledSegmentPath: string;
  manifestSegment: SegmentDiagnosticsManifestSegment;
};

type ProcessedSegmentCandidate = {
  candidateIndex: number;
  processedSegment: ProcessedSegment;
  candidatePenaltyScore: number;
  candidatePenaltyReasons: string[];
};

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
  const voiceId = typeof payload.voiceId === "string" ? payload.voiceId.trim() : "";
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
  const debugAudioEnabled = readBooleanEnv(process.env.VOICE_LAB_DEBUG_AUDIO);
  const masteringStrategy = resolveMasteringStrategy(process.env.VOICE_LAB_MASTERING_STRATEGY);
  const debugArtifactDirectoryPath = debugAudioEnabled
    ? await mkdtemp(path.join(tmpdir(), "voice-lab-debug-"))
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

    const providerConfig = resolveMistralProviderConfig();
    const resolvedVoiceId = voiceId || providerConfig.defaultVoiceId;

    validateEnvironment(resolvedVoiceId);

    sendEvent({
      type: "progress",
      stage: "cleaning",
      message: "Cleaning text"
    });

    const preparedText = prepareTextForSpeech(text);

    if (!preparedText.cleanedText) {
      throw new Error("The cleaned text is empty. Paste longer plain-language content.");
    }

    const filename = `${slugifyFilename(title, "voice-lab")}.${getFileExtension(outputFormat)}`;

    if (forceSegmentedMode || !continuousRead) {
      const segmentedResult = await generateSegmentedSpeech({
        paragraphs: preparedText.paragraphs,
        voiceId: resolvedVoiceId,
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
        voiceId: resolvedVoiceId,
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
      voiceId: resolvedVoiceId,
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
  if (!voiceId) {
    throw new Error("Missing voice ID. Pick a saved voice or set MISTRAL_VOICE_ID server-side.");
  }
}

async function prepareSegmentsForJoinSmoothing({
  segmentPaths,
  tempDirectoryPath,
  smoothJoins,
  joinPlan
}: {
  segmentPaths: string[];
  tempDirectoryPath: string;
  smoothJoins: boolean;
  joinPlan: SegmentJoinPlan[];
}): Promise<string[]> {
  if (!smoothJoins || segmentPaths.length < 2) {
    return segmentPaths;
  }

  const smoothedPaths: string[] = [];

  for (let index = 0; index < segmentPaths.length; index += 1) {
    smoothedPaths.push(segmentPaths[index]);

    if (index < segmentPaths.length - 1) {
      const boundary = joinPlan[index];
      const pauseMs = boundary?.pauseMs ?? DEFAULT_JOIN_PAUSE_MS;
      const joinGapPath = path.join(
        tempDirectoryPath,
        `join-gap-${String(index + 1).padStart(3, "0")}-${pauseMs}ms.wav`
      );

      await generateSilenceAudioFile({
        outputPath: joinGapPath,
        durationMs: pauseMs,
        sampleRate: STANDARD_INTERMEDIATE_SAMPLE_RATE,
        channels: STANDARD_INTERMEDIATE_CHANNELS
      });

      smoothedPaths.push(joinGapPath);
    }
  }

  return smoothedPaths;
}

async function mergeSegmentsWithFallback({
  segmentPaths,
  tempDirectoryPath,
  sendEvent
}: {
  segmentPaths: string[];
  tempDirectoryPath: string;
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
    const fallbackMergedPath = path.join(tempDirectoryPath, "merged-reencoded.wav");

    sendEvent({
      type: "progress",
      stage: "merging",
      message: `Merging audio again with re-encoding (${truncate(concatFailureReason, 120)})`
    });

    try {
      await mergeAudioFiles({
        inputPaths: segmentPaths,
        outputPath: fallbackMergedPath,
        outputFormat: INTERMEDIATE_SEGMENT_FORMAT,
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
  masteringResult: AudioMasteringResult | null;
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
        normalizationFallbackUsed: false,
        masteringResult: null
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
      normalizationFallbackUsed: false,
      masteringResult: null
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
    const masteringResult = await masterAudioFile({
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
      normalizationFallbackUsed: false,
      masteringResult
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
        normalizationFallbackUsed: true,
        masteringResult: null
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
      normalizationFallbackUsed: true,
      masteringResult: null
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

  const tempDirectoryPath = await mkdtemp(path.join(tmpdir(), "voice-lab-"));
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
  let segments = chunkText(paragraphs);

  if (segments.length === 0) {
    throw new Error("No narration segments were created after cleaning.");
  }

  sendEvent({
    type: "progress",
    stage: "segmenting",
    message: preparationMessage
  });

  const tempDirectoryPath = await mkdtemp(path.join(tmpdir(), "voice-lab-"));
  let processedSegments: ProcessedSegment[] = [];
  let joinPlan = buildSegmentJoinPlan(
    segments.map((segment) => segment.text),
    smoothJoins
  );
  const seamRegenerationEnabled =
    process.env.VOICE_LAB_REGENERATE_BAD_SEAMS?.trim().toLowerCase() !== "false";
  const contextOverlapEnabled = readBooleanEnv(
    process.env.VOICE_LAB_CONTEXT_OVERLAP,
    true
  );
  const toneSeamScoringEnabled = readBooleanEnv(
    process.env.VOICE_LAB_TONE_SEAM_SCORING,
    true
  );
  const seamRetryCount = readPositiveIntegerEnv(
    process.env.VOICE_LAB_SEAM_RETRIES,
    DEFAULT_SEAM_RETRY_COUNT
  );
  const multiTakeCount = resolveMultiTakeCount(process.env.VOICE_LAB_MULTI_TAKE_COUNT);
  let multiTakeOptimization: MultiTakeOptimizationManifest | null = null;

  try {
    await assertFfmpegAvailable();

    console.info(
      "[segmented] chunking",
      JSON.stringify({
        totalSegments: segments.length,
        wordCounts: segments.map((segment) => segment.wordCount),
        multiTakeCount
      })
    );

    for (let index = 0; index < segments.length; index += 1) {
      processedSegments.push(
        await generateAndProcessSegment({
          segments,
          segmentIndex: index,
          totalSegments: segments.length,
          attempt: 1,
          contextOverlapEnabled,
          tempDirectoryPath,
          voiceId,
          sendEvent,
          debugArtifactDirectoryPath
        })
      );
    }

    let boundaryDiagnostics = buildSegmentBoundaryDiagnostics(
      processedSegments.map((segment) => segment.manifestSegment.leveledMetrics),
      joinPlan.map((join) => join.pauseMs / 1000),
      undefined,
      undefined,
      {
        wordCounts: segments.map((segment) => segment.wordCount),
        toneSeamScoringEnabled
      }
    );
    hydrateBoundaryContextDiagnostics(boundaryDiagnostics, segments, processedSegments);

    if (seamRegenerationEnabled) {
      const regenerationResult = await regenerateFailedSeams({
        segments,
        processedSegments,
        boundaryDiagnostics,
        joinPlan,
        tempDirectoryPath,
        voiceId,
        sendEvent,
        contextOverlapEnabled,
        toneSeamScoringEnabled,
        seamRetryCount,
        smoothJoins,
        debugArtifactDirectoryPath
      });
      segments = regenerationResult.segments;
      processedSegments = regenerationResult.processedSegments;
      joinPlan = regenerationResult.joinPlan;
      boundaryDiagnostics = regenerationResult.boundaryDiagnostics;
    }

    if (multiTakeCount > 1) {
      const optimizationResult = await optimizeMultiTakeSegments({
        segments,
        processedSegments,
        joinPlan,
        takeCount: multiTakeCount,
        tempDirectoryPath,
        voiceId,
        sendEvent,
        contextOverlapEnabled,
        toneSeamScoringEnabled,
        debugArtifactDirectoryPath
      });
      processedSegments = optimizationResult.processedSegments;
      boundaryDiagnostics = optimizationResult.boundaryDiagnostics;
      multiTakeOptimization = optimizationResult.multiTakeOptimization;
    } else {
      multiTakeOptimization = buildMultiTakeOptimizationForCandidateGroups({
        candidateGroups: processedSegments.map((segment) => [
          toProcessedSegmentCandidate(segment, 0)
        ]),
        joinPlan,
        segments,
        toneSeamScoringEnabled,
        enabled: false,
        takeCount: multiTakeCount
      }).multiTakeOptimization;
    }

    boundaryDiagnostics = await applyBoundaryAwareSeamAdjustments({
      processedSegments,
      boundaryDiagnostics,
      joinPlan,
      tempDirectoryPath,
      segments,
      toneSeamScoringEnabled,
      debugArtifactDirectoryPath
    });

    const rawSegmentPaths = processedSegments.map((segment) => segment.rawSegmentPath);
    const leveledSegmentPaths = processedSegments.map((segment) => segment.leveledSegmentPath);
    const manifestSegments = processedSegments.map((segment) => segment.manifestSegment);

    if (!multiTakeOptimization) {
      throw new Error("Multi-take optimization manifest was not initialized.");
    }

    multiTakeOptimization = finalizeMultiTakeOptimizationManifest({
      multiTakeOptimization,
      boundaries: boundaryDiagnostics,
      durationSeconds: sumSegmentDurationSeconds(manifestSegments, joinPlan)
    });
    logPublishabilityVerdict(multiTakeOptimization);

    if (debugArtifactDirectoryPath) {
      await persistSegmentedRawDebugArtifact({
        segmentPaths: rawSegmentPaths,
        tempDirectoryPath,
        debugArtifactDirectoryPath
      });
    }

    if (smoothJoins && leveledSegmentPaths.length > 1) {
      sendEvent({
        type: "progress",
        stage: "smoothing",
        message: "Smoothing joins"
      });
    }

    const joinReadyPaths = await prepareSegmentsForJoinSmoothing({
      segmentPaths: leveledSegmentPaths,
      tempDirectoryPath,
      smoothJoins,
      joinPlan
    });

    const assembledPath = await mergeSegmentsWithFallback({
      segmentPaths: joinReadyPaths,
      tempDirectoryPath,
      sendEvent
    });

    logSegmentedBoundaryDiagnostics(boundaryDiagnostics);

    if (debugArtifactDirectoryPath) {
      await persistAudioDebugArtifact({
        sourcePath: assembledPath,
        directoryPath: debugArtifactDirectoryPath,
        filename: "merged-premaster.wav",
        note: "Merged leveled WAV segments before final mastering."
      });

      await persistSeamDebugArtifacts({
        assembledPath,
        debugArtifactDirectoryPath,
        boundaries: boundaryDiagnostics,
        smoothJoins
      });
    }

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
    const diagnosticsWarnings = collectSegmentDiagnosticsWarnings({
      boundaries: boundaryDiagnostics,
      segmentMetrics: manifestSegments.map((segment) => segment.leveledMetrics),
      finalMetrics: finalizedOutput.masteringResult?.metrics ?? null,
      finalTruePeakTarget: VOLUME_BOOST_SETTINGS[volumeBoost].truePeak
    });

    logSegmentedDiagnosticsWarnings(diagnosticsWarnings);

    if (debugArtifactDirectoryPath) {
      await persistSegmentedDiagnosticsManifest({
        debugArtifactDirectoryPath,
        manifest: {
          version: 1,
          createdAt: new Date().toISOString(),
          totalSegments: segments.length,
          smoothJoins,
          joinPauseMs: smoothJoins && segments.length > 1 ? DEFAULT_JOIN_PAUSE_MS : 0,
          joinPlan,
          segmentLeveling: SEGMENT_LEVELING_SETTINGS,
          segments: manifestSegments,
          boundaries: boundaryDiagnostics,
          warnings: diagnosticsWarnings,
          finalMetrics: finalizedOutput.masteringResult?.metrics ?? null,
          multiTakeOptimization
        }
      });
    }

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

async function generateAndProcessSegment({
  segments,
  segmentIndex,
  totalSegments,
  attempt,
  contextOverlapEnabled,
  continuityStrength,
  regenerationReason,
  tempDirectoryPath,
  voiceId,
  sendEvent,
  debugArtifactDirectoryPath
}: {
  segments: TextChunk[];
  segmentIndex: number;
  totalSegments: number;
  attempt: number;
  contextOverlapEnabled: boolean;
  continuityStrength?: "standard" | "strong";
  regenerationReason?: string;
  tempDirectoryPath: string;
  voiceId: string;
  sendEvent: (event: StreamEvent) => void;
  debugArtifactDirectoryPath?: string;
}): Promise<ProcessedSegment> {
  const segment = segments[segmentIndex];

  if (!segment) {
    throw new Error(`Missing segment ${segmentIndex + 1}.`);
  }

  const segmentNumber = segmentIndex + 1;
  const segmentId = String(segmentNumber).padStart(3, "0");
  const attemptSuffix = attempt > 1 ? `-attempt-${attempt}` : "";
  const prompt = buildSegmentContinuityPrompt({
    previousText: segments[segmentIndex - 1]?.text,
    targetText: segment.text,
    nextText: segments[segmentIndex + 1]?.text,
    enabled: false,
    instructionStrength: continuityStrength ?? (attempt > 1 ? "strong" : "standard")
  });
  const continuityContextPrompt = buildSegmentContinuityPrompt({
    previousText: segments[segmentIndex - 1]?.text,
    targetText: segment.text,
    nextText: segments[segmentIndex + 1]?.text,
    enabled: contextOverlapEnabled,
    instructionStrength: continuityStrength ?? (attempt > 1 ? "strong" : "standard")
  });

  sendEvent({
    type: "progress",
    stage: "generating",
    message:
      attempt > 1
        ? `Regenerating section ${segmentNumber} of ${totalSegments}`
        : `Generating section ${segmentNumber} of ${totalSegments}`,
    currentSegment: segmentNumber,
    totalSegments
  });

  const spokenOverlapInput =
    contextOverlapEnabled && continuityContextPrompt.previousContext
      ? buildSpokenContextOverlapInput({
          previousContext: continuityContextPrompt.previousContext,
          targetText: segment.text
        })
      : null;
  const audioBuffer = await generateSegmentSpeech({
    input: spokenOverlapInput?.input ?? prompt.input,
    voiceId,
    segmentNumber,
    totalSegments
  });

  const rawSegmentPath = path.join(
    tempDirectoryPath,
    `segment-${segmentId}${attemptSuffix}-raw.wav`
  );

  await writeFile(rawSegmentPath, audioBuffer);
  let rawMetrics = await measureSegmentAudioFile(rawSegmentPath);
  let finalRawSegmentPath = rawSegmentPath;
  let finalPrompt: SegmentContinuityPrompt = spokenOverlapInput
    ? {
        ...continuityContextPrompt,
        input: spokenOverlapInput.input,
        nextContext: "",
        contextOverlapUsed: true,
        instructionStrength: continuityStrength ?? (attempt > 1 ? "strong" : "standard"),
        inputWordCount: spokenOverlapInput.inputWordCount
      }
    : prompt;
  let contextLikelySpoken = false;
  let contextFallbackUsed = false;
  let contextAudioTrimmed = false;
  let contextAudioTrimSeconds: number | null = null;
  let contextAudioTrimEstimatedSeconds: number | null = null;
  let contextAudioTrimSearch: Awaited<ReturnType<typeof selectAcousticTrimPoint>> | null = null;

  if (spokenOverlapInput && rawMetrics.durationSeconds !== null) {
    const estimatedTrimSeconds = estimateContextAudioTrimSeconds({
      durationSeconds: rawMetrics.durationSeconds,
      contextWordCount: spokenOverlapInput.contextWordCount,
      targetWordCount: segment.wordCount
    });
    contextAudioTrimEstimatedSeconds = estimatedTrimSeconds;
    contextAudioTrimSearch = await selectAcousticTrimPoint({
      inputPath: rawSegmentPath,
      durationSeconds: rawMetrics.durationSeconds,
      estimatedTrimSeconds
    });
    const trimSeconds = contextAudioTrimSearch.selectedTrimSeconds;
    const trimmedPath = path.join(
      tempDirectoryPath,
      `segment-${segmentId}${attemptSuffix}-raw-context-trimmed.wav`
    );

    await extractAudioClip({
      inputPath: rawSegmentPath,
      outputPath: trimmedPath,
      startSeconds: trimSeconds,
      durationSeconds: Math.max(0.5, rawMetrics.durationSeconds - trimSeconds)
    });

    finalRawSegmentPath = trimmedPath;
    rawMetrics = await measureSegmentAudioFile(finalRawSegmentPath);
    contextAudioTrimmed = true;
    contextAudioTrimSeconds = trimSeconds;

    if (isContextTrimLikelyBadTake(rawMetrics)) {
      console.warn(
        "[segmented] context-overlap-trim-rejected",
        JSON.stringify({
          segmentIndex: segmentNumber,
          trimSeconds,
          integratedLoudness: rawMetrics.integratedLoudness,
          truePeak: rawMetrics.truePeak,
          internalDriftLufs: rawMetrics.internalDriftLufs
        })
      );

      finalPrompt = buildSegmentContinuityPrompt({
        targetText: segment.text,
        enabled: false
      });
      const targetOnlyAudioBuffer = await generateSegmentSpeech({
        input: finalPrompt.input,
        voiceId,
        segmentNumber,
        totalSegments
      });
      finalRawSegmentPath = path.join(
        tempDirectoryPath,
        `segment-${segmentId}${attemptSuffix}-raw-target-only.wav`
      );
      await writeFile(finalRawSegmentPath, targetOnlyAudioBuffer);
      rawMetrics = await measureSegmentAudioFile(finalRawSegmentPath);
      contextFallbackUsed = true;
      contextAudioTrimmed = false;
      contextAudioTrimSeconds = null;
      contextAudioTrimEstimatedSeconds = null;
      contextAudioTrimSearch = null;
    }
  } else if (contextLikelySpoken) {
    console.warn(
      "[segmented] context-overlap-likely-spoken",
      JSON.stringify({
        segmentIndex: segmentNumber,
        targetWordCount: prompt.targetWordCount,
        inputWordCount: prompt.inputWordCount,
        durationSeconds: rawMetrics.durationSeconds
      })
    );

    finalPrompt = buildSegmentContinuityPrompt({
      targetText: segment.text,
      enabled: false
    });
    const targetOnlyAudioBuffer = await generateSegmentSpeech({
      input: finalPrompt.input,
      voiceId,
      segmentNumber,
      totalSegments
    });
    finalRawSegmentPath = path.join(
      tempDirectoryPath,
      `segment-${segmentId}${attemptSuffix}-raw-target-only.wav`
    );
    await writeFile(finalRawSegmentPath, targetOnlyAudioBuffer);
    rawMetrics = await measureSegmentAudioFile(finalRawSegmentPath);
    contextFallbackUsed = true;
  }

  if (debugArtifactDirectoryPath) {
    await persistSegmentDebugArtifact({
      sourcePath: finalRawSegmentPath,
      debugArtifactDirectoryPath,
      segmentNumber,
      attempt,
      kind: "raw"
    });
  }

  sendEvent({
    type: "progress",
    stage: "normalizing",
    message: `Leveling section ${segmentNumber} of ${totalSegments}`,
    currentSegment: segmentNumber,
    totalSegments
  });

  const standardizedSegmentPath = path.join(
    tempDirectoryPath,
    `segment-${segmentId}${attemptSuffix}-standardized.wav`
  );

  await standardizeSegmentAudioFile({
    inputPath: finalRawSegmentPath,
    outputPath: standardizedSegmentPath
  });

  const standardizedMetrics = await measureSegmentAudioFile(standardizedSegmentPath);

  if (debugArtifactDirectoryPath) {
    await persistSegmentDebugArtifact({
      sourcePath: standardizedSegmentPath,
      debugArtifactDirectoryPath,
      segmentNumber,
      attempt,
      kind: "standardized"
    });
  }

  const leveledSegmentPath = path.join(
    tempDirectoryPath,
    `segment-${segmentId}${attemptSuffix}-leveled.wav`
  );
  const levelingResult = await levelSegmentAudioFile({
    inputPath: standardizedSegmentPath,
    outputPath: leveledSegmentPath,
    metrics: standardizedMetrics
  });
  const leveledMetrics = await measureSegmentAudioFile(leveledSegmentPath, {
    includeEdgeTone: true
  });

  if (debugArtifactDirectoryPath) {
    await persistSegmentDebugArtifact({
      sourcePath: leveledSegmentPath,
      debugArtifactDirectoryPath,
      segmentNumber,
      attempt,
      kind: "leveled"
    });
  }

  return {
    rawSegmentPath: finalRawSegmentPath,
    standardizedSegmentPath,
    leveledSegmentPath,
    manifestSegment: {
      segmentIndex: segmentNumber,
      wordCount: segment.wordCount,
      generationAttempt: attempt,
      generationInputWordCount: finalPrompt.inputWordCount,
      targetWordCount: finalPrompt.targetWordCount,
      contextOverlapUsed: finalPrompt.contextOverlapUsed,
      contextInstructionStrength: finalPrompt.instructionStrength,
      previousContext: finalPrompt.previousContext,
      nextContext: finalPrompt.nextContext,
      contextLikelySpoken,
      contextFallbackUsed,
      contextAudioTrimmed,
      contextAudioTrimSeconds,
      contextAudioTrimEstimatedSeconds,
      contextAudioTrimSearch,
      regenerationReason,
      rawMetrics,
      standardizedMetrics,
      leveledMetrics,
      appliedGainDb: levelingResult.appliedGainDb,
      driftCorrectionDb: levelingResult.driftCorrectionDb,
      levelingFilter: levelingResult.filter
    }
  };
}

async function regenerateFailedSeams({
  segments,
  processedSegments,
  boundaryDiagnostics,
  joinPlan,
  tempDirectoryPath,
  voiceId,
  sendEvent,
  contextOverlapEnabled,
  toneSeamScoringEnabled,
  seamRetryCount,
  smoothJoins,
  debugArtifactDirectoryPath
}: {
  segments: TextChunk[];
  processedSegments: ProcessedSegment[];
  boundaryDiagnostics: SegmentBoundaryDiagnostic[];
  joinPlan: SegmentJoinPlan[];
  tempDirectoryPath: string;
  voiceId: string;
  sendEvent: (event: StreamEvent) => void;
  contextOverlapEnabled: boolean;
  toneSeamScoringEnabled: boolean;
  seamRetryCount: number;
  smoothJoins: boolean;
  debugArtifactDirectoryPath?: string;
}): Promise<{
  segments: TextChunk[];
  processedSegments: ProcessedSegment[];
  joinPlan: SegmentJoinPlan[];
  boundaryDiagnostics: SegmentBoundaryDiagnostic[];
}> {
  let currentSegments = segments;
  let currentProcessedSegments = processedSegments;
  let currentJoinPlan = joinPlan;
  const attemptRecordsByBoundary = new Map<number, SegmentBoundaryDiagnostic["regenerationAttempts"]>();
  const repairRecordsByBoundary = new Map<number, NonNullable<SegmentBoundaryDiagnostic["boundaryRepair"]>>();
  let currentDiagnostics =
    boundaryDiagnostics.length > 0
      ? boundaryDiagnostics
      : buildCurrentBoundaryDiagnostics({
          processedSegments: currentProcessedSegments,
          joinPlan: currentJoinPlan,
          segments: currentSegments,
          toneSeamScoringEnabled,
          attemptRecordsByBoundary,
          repairRecordsByBoundary
        });
  hydrateBoundaryContextDiagnostics(
    currentDiagnostics,
    currentSegments,
    currentProcessedSegments
  );

  if (!currentDiagnostics.some((boundary) => !boundary.seamPassed)) {
    return {
      segments: currentSegments,
      processedSegments: currentProcessedSegments,
      joinPlan: currentJoinPlan,
      boundaryDiagnostics: currentDiagnostics
    };
  }

  for (let retryIndex = 0; retryIndex < seamRetryCount; retryIndex += 1) {
    const attempt = retryIndex + 2;
    const targets = selectSeamRegenerationTargets(
      currentDiagnostics,
      currentProcessedSegments.map((segment) => segment.manifestSegment.leveledMetrics),
      MAX_SEAM_REGENERATION_SEGMENTS
    );

    if (targets.length === 0) {
      break;
    }

    console.warn(
      "[segmented] seam-regeneration",
      JSON.stringify({
        attempt,
        targets,
        failedBoundaries: currentDiagnostics
          .filter((boundary) => !boundary.seamPassed)
          .map((boundary) => ({
            boundaryIndex: boundary.boundaryIndex,
            seamQualityScore: boundary.seamQualityScore,
            failureKind: boundary.seamFailureKind,
            failureReason: boundary.seamFailureReason,
            deltaLufs: boundary.deltaLufs,
            rmsDeltaDb: boundary.rmsDeltaDb,
            gapDurationMs: boundary.gapDurationMs,
            spectralDifferenceScore: boundary.spectralDifferenceScore,
            edgeToneMismatchScore: boundary.edgeToneMismatchScore,
            edgeToneDelta: boundary.edgeToneDelta,
            speakingRateDeltaWps: boundary.speakingRateDeltaWps,
            toneMismatchScore: boundary.toneMismatchScore
          }))
      })
    );

    for (const segmentNumber of targets) {
      const segmentIndex = segmentNumber - 1;
      const previousSegment = currentProcessedSegments[segmentIndex];

      if (!previousSegment || !currentSegments[segmentIndex]) {
        continue;
      }

      const previousScore = scoreSeamsTouchingSegment(currentDiagnostics, segmentNumber);
      const regenerationReason = summarizeSeamsTouchingSegment(
        currentDiagnostics,
        segmentNumber
      );
      const candidate = await generateAndProcessSegment({
        segments: currentSegments,
        segmentIndex,
        totalSegments: currentSegments.length,
        attempt,
        contextOverlapEnabled,
        continuityStrength: "strong",
        regenerationReason,
        tempDirectoryPath,
        voiceId,
        sendEvent,
        debugArtifactDirectoryPath
      });

      currentProcessedSegments[segmentIndex] = candidate;

      const candidateDiagnostics = buildCurrentBoundaryDiagnostics({
        processedSegments: currentProcessedSegments,
        joinPlan: currentJoinPlan,
        segments: currentSegments,
        toneSeamScoringEnabled,
        attemptRecordsByBoundary,
        repairRecordsByBoundary
      });
      const candidateScore = scoreSeamsTouchingSegment(candidateDiagnostics, segmentNumber);
      const accepted = candidateScore <= previousScore;
      const record = {
        attempt,
        segmentIndex: segmentNumber,
        reason: regenerationReason,
        contextOverlapUsed: candidate.manifestSegment.contextOverlapUsed,
        contextLikelySpoken: candidate.manifestSegment.contextLikelySpoken,
        accepted,
        scoreBefore: previousScore,
        scoreAfter: candidateScore
      };

      recordRegenerationAttempt(attemptRecordsByBoundary, segmentNumber, currentSegments.length, record);

      if (accepted) {
        currentDiagnostics = buildCurrentBoundaryDiagnostics({
          processedSegments: currentProcessedSegments,
          joinPlan: currentJoinPlan,
          segments: currentSegments,
          toneSeamScoringEnabled,
          attemptRecordsByBoundary,
          repairRecordsByBoundary
        });
        console.info(
          "[segmented] seam-regeneration accepted",
          JSON.stringify({
            segmentIndex: segmentNumber,
            previousScore,
            candidateScore,
            regenerationReason,
            contextOverlapUsed: candidate.manifestSegment.contextOverlapUsed,
            contextLikelySpoken: candidate.manifestSegment.contextLikelySpoken
          })
        );
        continue;
      }

      currentProcessedSegments[segmentIndex] = previousSegment;
      currentDiagnostics = buildCurrentBoundaryDiagnostics({
        processedSegments: currentProcessedSegments,
        joinPlan: currentJoinPlan,
        segments: currentSegments,
        toneSeamScoringEnabled,
        attemptRecordsByBoundary,
        repairRecordsByBoundary
      });
      console.warn(
        "[segmented] seam-regeneration rejected",
        JSON.stringify({
          segmentIndex: segmentNumber,
          previousScore,
          candidateScore,
          regenerationReason
        })
      );
    }
  }

  const repairResult = await repairWorstRemainingSeam({
    segments: currentSegments,
    processedSegments: currentProcessedSegments,
    joinPlan: currentJoinPlan,
    boundaryDiagnostics: currentDiagnostics,
    attemptRecordsByBoundary,
    repairRecordsByBoundary,
    tempDirectoryPath,
    voiceId,
    sendEvent,
    smoothJoins,
    contextOverlapEnabled,
    toneSeamScoringEnabled,
    debugArtifactDirectoryPath
  });

  currentSegments = repairResult.segments;
  currentProcessedSegments = repairResult.processedSegments;
  currentJoinPlan = repairResult.joinPlan;
  currentDiagnostics = repairResult.boundaryDiagnostics;

  return {
    segments: currentSegments,
    processedSegments: currentProcessedSegments,
    joinPlan: currentJoinPlan,
    boundaryDiagnostics: currentDiagnostics
  };
}

function scoreSeamsTouchingSegment(
  boundaries: SegmentBoundaryDiagnostic[],
  segmentNumber: number
): number {
  return boundaries
    .filter(
      (boundary) =>
        boundary.previousSegmentIndex === segmentNumber ||
        boundary.nextSegmentIndex === segmentNumber
    )
    .reduce((total, boundary) => total + boundary.seamQualityScore, 0);
}

function summarizeSeamsTouchingSegment(
  boundaries: SegmentBoundaryDiagnostic[],
  segmentNumber: number
): string {
  const failures = boundaries
    .filter(
      (boundary) =>
        !boundary.seamPassed &&
        (boundary.previousSegmentIndex === segmentNumber ||
          boundary.nextSegmentIndex === segmentNumber)
    )
    .map(
      (boundary) =>
        `boundary-${boundary.boundaryIndex}-${boundary.seamFailureKind}-${boundary.seamFailureReason}`
    );

  return failures.join(";") || "retry-for-seam-continuity";
}

function buildCurrentBoundaryDiagnostics({
  processedSegments,
  joinPlan,
  segments,
  toneSeamScoringEnabled,
  attemptRecordsByBoundary,
  repairRecordsByBoundary
}: {
  processedSegments: ProcessedSegment[];
  joinPlan: SegmentJoinPlan[];
  segments: TextChunk[];
  toneSeamScoringEnabled: boolean;
  attemptRecordsByBoundary?: Map<
    number,
    SegmentBoundaryDiagnostic["regenerationAttempts"]
  >;
  repairRecordsByBoundary?: Map<
    number,
    NonNullable<SegmentBoundaryDiagnostic["boundaryRepair"]>
  >;
}): SegmentBoundaryDiagnostic[] {
  const diagnostics = buildSegmentBoundaryDiagnostics(
    processedSegments.map((segment) => segment.manifestSegment.leveledMetrics),
    joinPlan.map((join) => join.pauseMs / 1000),
    undefined,
    undefined,
    {
      wordCounts: segments.map((segment) => segment.wordCount),
      toneSeamScoringEnabled
    }
  );

  hydrateBoundaryContextDiagnostics(diagnostics, segments, processedSegments);

  for (const boundary of diagnostics) {
    boundary.regenerationAttempts = [
      ...(attemptRecordsByBoundary?.get(boundary.boundaryIndex) ?? [])
    ];
    boundary.boundaryRepair =
      repairRecordsByBoundary?.get(boundary.boundaryIndex) ?? boundary.boundaryRepair;
  }

  return diagnostics;
}

function hydrateBoundaryContextDiagnostics(
  diagnostics: SegmentBoundaryDiagnostic[],
  segments: TextChunk[],
  processedSegments: ProcessedSegment[]
): void {
  for (const boundary of diagnostics) {
    const previous = segments[boundary.previousSegmentIndex - 1];
    const next = segments[boundary.nextSegmentIndex - 1];
    const nextManifest = processedSegments[boundary.nextSegmentIndex - 1]?.manifestSegment;

    boundary.previousContextTail = previous ? extractLastSentences(previous.text, 2) : null;
    boundary.nextContextHead = next ? extractFirstSentences(next.text, 1) : null;
    boundary.contextOverlapUsed = nextManifest?.contextOverlapUsed ?? false;
  }
}

function recordRegenerationAttempt(
  attemptsByBoundary: Map<number, SegmentBoundaryDiagnostic["regenerationAttempts"]>,
  segmentNumber: number,
  totalSegments: number,
  record: SegmentBoundaryDiagnostic["regenerationAttempts"][number]
): void {
  const boundaryIndexes = [segmentNumber - 1, segmentNumber].filter(
    (boundaryIndex) => boundaryIndex >= 1 && boundaryIndex < totalSegments
  );

  for (const boundaryIndex of boundaryIndexes) {
    const records = attemptsByBoundary.get(boundaryIndex) ?? [];
    attemptsByBoundary.set(boundaryIndex, [...records, record]);
  }
}

async function repairWorstRemainingSeam({
  segments,
  processedSegments,
  joinPlan,
  boundaryDiagnostics,
  attemptRecordsByBoundary,
  repairRecordsByBoundary,
  tempDirectoryPath,
  voiceId,
  sendEvent,
  smoothJoins,
  contextOverlapEnabled,
  toneSeamScoringEnabled,
  debugArtifactDirectoryPath
}: {
  segments: TextChunk[];
  processedSegments: ProcessedSegment[];
  joinPlan: SegmentJoinPlan[];
  boundaryDiagnostics: SegmentBoundaryDiagnostic[];
  attemptRecordsByBoundary: Map<number, SegmentBoundaryDiagnostic["regenerationAttempts"]>;
  repairRecordsByBoundary: Map<number, NonNullable<SegmentBoundaryDiagnostic["boundaryRepair"]>>;
  tempDirectoryPath: string;
  voiceId: string;
  sendEvent: (event: StreamEvent) => void;
  smoothJoins: boolean;
  contextOverlapEnabled: boolean;
  toneSeamScoringEnabled: boolean;
  debugArtifactDirectoryPath?: string;
}): Promise<{
  segments: TextChunk[];
  processedSegments: ProcessedSegment[];
  joinPlan: SegmentJoinPlan[];
  boundaryDiagnostics: SegmentBoundaryDiagnostic[];
}> {
  const worstBoundary = boundaryDiagnostics
    .filter(
      (boundary) =>
        !boundary.seamPassed &&
        (boundary.seamFailureKind === "tonal" || boundary.seamFailureKind === "mixed")
    )
    .sort((left, right) => right.seamQualityScore - left.seamQualityScore)[0];

  if (!worstBoundary) {
    return {
      segments,
      processedSegments,
      joinPlan,
      boundaryDiagnostics
    };
  }

  const repair = repairChunkBoundary(segments, worstBoundary.boundaryIndex);

  if (!repair.applied) {
    repairRecordsByBoundary.set(worstBoundary.boundaryIndex, toBoundaryRepairRecord(repair));
    return {
      segments,
      processedSegments,
      joinPlan,
      boundaryDiagnostics: buildCurrentBoundaryDiagnostics({
        processedSegments,
        joinPlan,
        segments,
        toneSeamScoringEnabled,
        attemptRecordsByBoundary,
        repairRecordsByBoundary
      })
    };
  }

  console.warn(
    "[segmented] seam-boundary-repair",
    JSON.stringify({
      boundaryIndex: worstBoundary.boundaryIndex,
      strategy: repair.strategy,
      reason: repair.reason
    })
  );

  const repairedSegments = repair.chunks;
  const repairedJoinPlan = buildSegmentJoinPlan(
    repairedSegments.map((segment) => segment.text),
    smoothJoins
  );
  const repairedProcessedSegments: ProcessedSegment[] = [];

  for (let index = 0; index < repairedSegments.length; index += 1) {
    repairedProcessedSegments.push(
      await generateAndProcessSegment({
        segments: repairedSegments,
        segmentIndex: index,
        totalSegments: repairedSegments.length,
        attempt: 100 + index,
        contextOverlapEnabled,
        continuityStrength: "strong",
        regenerationReason: `boundary-repair-${repair.strategy}-${repair.reason}`,
        tempDirectoryPath,
        voiceId,
        sendEvent,
        debugArtifactDirectoryPath
      })
    );
  }

  const repairedBoundaryIndex = Math.min(
    repair.boundaryIndex,
    Math.max(1, repairedSegments.length - 1)
  );
  repairRecordsByBoundary.set(repairedBoundaryIndex, toBoundaryRepairRecord(repair));

  return {
    segments: repairedSegments,
    processedSegments: repairedProcessedSegments,
    joinPlan: repairedJoinPlan,
    boundaryDiagnostics: buildCurrentBoundaryDiagnostics({
      processedSegments: repairedProcessedSegments,
      joinPlan: repairedJoinPlan,
      segments: repairedSegments,
      toneSeamScoringEnabled,
      repairRecordsByBoundary
    })
  };
}

function toBoundaryRepairRecord(
  repair: ChunkBoundaryRepair
): NonNullable<SegmentBoundaryDiagnostic["boundaryRepair"]> {
  return {
    applied: repair.applied,
    strategy: repair.strategy,
    reason: repair.reason
  };
}

async function applyBoundaryAwareSeamAdjustments({
  processedSegments,
  boundaryDiagnostics,
  joinPlan,
  tempDirectoryPath,
  segments,
  toneSeamScoringEnabled,
  debugArtifactDirectoryPath
}: {
  processedSegments: ProcessedSegment[];
  boundaryDiagnostics: SegmentBoundaryDiagnostic[];
  joinPlan: SegmentJoinPlan[];
  tempDirectoryPath: string;
  segments: TextChunk[];
  toneSeamScoringEnabled: boolean;
  debugArtifactDirectoryPath?: string;
}): Promise<SegmentBoundaryDiagnostic[]> {
  const adjustments = computeSegmentSeamAdjustments(boundaryDiagnostics, processedSegments.length);
  const actionableAdjustments = adjustments.filter(
    (adjustment) =>
      adjustment.startCutDb >= 0.05 ||
      adjustment.endCutDb >= 0.05 ||
      adjustment.entrySmoothingCutDb >= 0.05
  );

  if (actionableAdjustments.length === 0) {
    hydrateBoundaryContextDiagnostics(boundaryDiagnostics, segments, processedSegments);
    return boundaryDiagnostics;
  }

  console.info(
    "[segmented] seam-edge-adjustments",
    JSON.stringify({
      adjustments: actionableAdjustments.map((adjustment) => ({
        segmentIndex: adjustment.segmentIndex,
        startCutDb: adjustment.startCutDb,
        endCutDb: adjustment.endCutDb,
        entrySmoothingCutDb: adjustment.entrySmoothingCutDb,
        entrySmoothingBoundaryIndex: adjustment.entrySmoothingBoundaryIndex,
        entrySmoothingReason: adjustment.entrySmoothingReason
      }))
    })
  );

  for (const adjustment of actionableAdjustments) {
    const segmentArrayIndex = adjustment.segmentIndex - 1;
    const processedSegment = processedSegments[segmentArrayIndex];
    const segmentId = String(adjustment.segmentIndex).padStart(3, "0");
    const adjustedPath = path.join(tempDirectoryPath, `segment-${segmentId}-seam-adjusted.wav`);
    const durationSeconds = processedSegment.manifestSegment.leveledMetrics.durationSeconds;
    const filter = buildSegmentSeamAdjustmentFilter(adjustment, durationSeconds);

    if (!filter) {
      continue;
    }

    await applySegmentSeamAdjustmentAudioFile({
      inputPath: processedSegment.leveledSegmentPath,
      outputPath: adjustedPath,
      adjustment: {
        ...adjustment,
        filter
      },
      durationSeconds
    });

    const adjustedMetrics = await measureSegmentAudioFile(adjustedPath, {
      includeEdgeTone: true
    });
    processedSegment.leveledSegmentPath = adjustedPath;
    processedSegment.manifestSegment.leveledMetrics = adjustedMetrics;
    processedSegment.manifestSegment.seamStartCutDb = adjustment.startCutDb;
    processedSegment.manifestSegment.seamEndCutDb = adjustment.endCutDb;
    processedSegment.manifestSegment.seamEntrySmoothingCutDb =
      adjustment.entrySmoothingCutDb;
    processedSegment.manifestSegment.seamEntrySmoothingReason =
      adjustment.entrySmoothingReason;
    processedSegment.manifestSegment.seamAdjustmentFilter = filter;

    if (debugArtifactDirectoryPath) {
      await persistSegmentDebugArtifact({
        sourcePath: adjustedPath,
        debugArtifactDirectoryPath,
        segmentNumber: adjustment.segmentIndex,
        attempt: processedSegment.manifestSegment.generationAttempt,
        kind: "seam-adjusted"
      });
    }
  }

  const adjustedDiagnostics = buildCurrentBoundaryDiagnostics({
    processedSegments,
    joinPlan,
    segments,
    toneSeamScoringEnabled,
    attemptRecordsByBoundary: new Map(
      boundaryDiagnostics.map((boundary) => [
        boundary.boundaryIndex,
        boundary.regenerationAttempts
      ])
    ),
    repairRecordsByBoundary: new Map(
      boundaryDiagnostics
        .filter((boundary) => boundary.boundaryRepair !== null)
        .map((boundary) => [
          boundary.boundaryIndex,
          boundary.boundaryRepair as NonNullable<SegmentBoundaryDiagnostic["boundaryRepair"]>
        ])
    )
  });
  hydrateEntrySmoothingDiagnostics(adjustedDiagnostics, adjustments);
  return adjustedDiagnostics;
}

function hydrateEntrySmoothingDiagnostics(
  diagnostics: SegmentBoundaryDiagnostic[],
  adjustments: ReturnType<typeof computeSegmentSeamAdjustments>
): void {
  for (const adjustment of adjustments) {
    if (
      adjustment.entrySmoothingBoundaryIndex === null ||
      adjustment.entrySmoothingCutDb < 0.05
    ) {
      continue;
    }

    const boundary = diagnostics.find(
      (entry) => entry.boundaryIndex === adjustment.entrySmoothingBoundaryIndex
    );

    if (!boundary) {
      continue;
    }

    boundary.entrySmoothingApplied = true;
    boundary.entrySmoothingCutDb = adjustment.entrySmoothingCutDb;
    boundary.entrySmoothingReason = adjustment.entrySmoothingReason;
  }
}

async function optimizeMultiTakeSegments({
  segments,
  processedSegments,
  joinPlan,
  takeCount,
  tempDirectoryPath,
  voiceId,
  sendEvent,
  contextOverlapEnabled,
  toneSeamScoringEnabled,
  debugArtifactDirectoryPath
}: {
  segments: TextChunk[];
  processedSegments: ProcessedSegment[];
  joinPlan: SegmentJoinPlan[];
  takeCount: number;
  tempDirectoryPath: string;
  voiceId: string;
  sendEvent: (event: StreamEvent) => void;
  contextOverlapEnabled: boolean;
  toneSeamScoringEnabled: boolean;
  debugArtifactDirectoryPath?: string;
}): Promise<{
  processedSegments: ProcessedSegment[];
  boundaryDiagnostics: SegmentBoundaryDiagnostic[];
  multiTakeOptimization: MultiTakeOptimizationManifest;
}> {
  const candidateGroups: ProcessedSegmentCandidate[][] = processedSegments.map((segment) => [
    toProcessedSegmentCandidate(segment, 0)
  ]);

  console.info(
    "[segmented] multi-take-optimization",
    JSON.stringify({
      takeCount,
      totalSegments: segments.length
    })
  );

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    for (let candidateIndex = 1; candidateIndex < takeCount; candidateIndex += 1) {
      const attempt = 200 + candidateIndex;

      sendEvent({
        type: "progress",
        stage: "generating",
        message: `Generating alternate take ${candidateIndex + 1} of ${takeCount} for section ${
          segmentIndex + 1
        } of ${segments.length}`,
        currentSegment: segmentIndex + 1,
        totalSegments: segments.length
      });

      const candidate = await generateAndProcessSegment({
        segments,
        segmentIndex,
        totalSegments: segments.length,
        attempt,
        contextOverlapEnabled,
        continuityStrength: "strong",
        regenerationReason: `multi-take-candidate-${candidateIndex + 1}`,
        tempDirectoryPath,
        voiceId,
        sendEvent,
        debugArtifactDirectoryPath
      });

      candidateGroups[segmentIndex].push(
        toProcessedSegmentCandidate(candidate, candidateIndex)
      );
    }
  }

  const { selectedProcessedSegments, boundaryDiagnostics, multiTakeOptimization } =
    buildMultiTakeOptimizationForCandidateGroups({
      candidateGroups,
      joinPlan,
      segments,
      toneSeamScoringEnabled,
      enabled: true,
      takeCount
    });

  console.info(
    "[segmented] multi-take-selection",
    JSON.stringify({
      baselinePath: multiTakeOptimization.baselinePath,
      chosenPath: multiTakeOptimization.chosenPath,
      baselineTotalScore: multiTakeOptimization.baselineTotalScore,
      chosenTotalScore: multiTakeOptimization.chosenTotalScore,
      improvementPercentage: multiTakeOptimization.improvementPercentage,
      worstSeamBefore: multiTakeOptimization.worstSeamBefore,
      worstSeamAfter: multiTakeOptimization.worstSeamAfter
    })
  );

  return {
    processedSegments: selectedProcessedSegments,
    boundaryDiagnostics,
    multiTakeOptimization
  };
}

function buildMultiTakeOptimizationForCandidateGroups({
  candidateGroups,
  joinPlan,
  segments,
  toneSeamScoringEnabled,
  enabled,
  takeCount
}: {
  candidateGroups: ProcessedSegmentCandidate[][];
  joinPlan: SegmentJoinPlan[];
  segments: TextChunk[];
  toneSeamScoringEnabled: boolean;
  enabled: boolean;
  takeCount: number;
}): {
  selectedProcessedSegments: ProcessedSegment[];
  boundaryDiagnostics: SegmentBoundaryDiagnostic[];
  multiTakeOptimization: MultiTakeOptimizationManifest;
} {
  const candidateInputs = candidateGroups.map((group) =>
    group.map(
      (candidate): MultiTakeCandidateInput => ({
        segmentIndex: candidate.processedSegment.manifestSegment.segmentIndex,
        candidateIndex: candidate.candidateIndex,
        metrics: candidate.processedSegment.manifestSegment.leveledMetrics,
        generationAttempt: candidate.processedSegment.manifestSegment.generationAttempt,
        contextOverlapUsed: candidate.processedSegment.manifestSegment.contextOverlapUsed,
        contextFallbackUsed: candidate.processedSegment.manifestSegment.contextFallbackUsed,
        contextAudioTrimmed: candidate.processedSegment.manifestSegment.contextAudioTrimmed,
        contextAudioTrimSeconds:
          candidate.processedSegment.manifestSegment.contextAudioTrimSeconds,
        contextAudioTrimEstimatedSeconds:
          candidate.processedSegment.manifestSegment.contextAudioTrimEstimatedSeconds,
        contextAudioTrimSearch:
          candidate.processedSegment.manifestSegment.contextAudioTrimSearch
      })
    )
  );
  const pairwiseSeamScoreMatrix = buildMultiTakePairwiseSeamScoreMatrix({
    candidates: candidateInputs,
    joinPlan,
    wordCounts: segments.map((segment) => segment.wordCount),
    toneSeamScoringEnabled
  });
  const candidatePenaltyScores = candidateGroups.map((group) =>
    group.map((candidate) => candidate.candidatePenaltyScore)
  );
  const selection = selectBestMultiTakePath({
    candidatePenaltyScores,
    pairwiseSeamScoreMatrix
  });
  const selectedProcessedSegments = selection.chosenPath.map((candidateIndex, segmentIndex) => {
    const candidate = candidateGroups[segmentIndex].find(
      (entry) => entry.candidateIndex === candidateIndex
    );

    if (!candidate) {
      throw new Error(
        `Missing selected candidate ${candidateIndex} for segment ${segmentIndex + 1}.`
      );
    }

    return candidate.processedSegment;
  });
  const boundaryDiagnostics = buildCurrentBoundaryDiagnostics({
    processedSegments: selectedProcessedSegments,
    joinPlan,
    segments,
    toneSeamScoringEnabled
  });
  const multiTakeOptimization = buildMultiTakeOptimizationManifest({
    candidateGroups,
    pairwiseSeamScoreMatrix,
    selection,
    enabled,
    takeCount
  });

  return {
    selectedProcessedSegments,
    boundaryDiagnostics,
    multiTakeOptimization
  };
}

function buildMultiTakeOptimizationManifest({
  candidateGroups,
  pairwiseSeamScoreMatrix,
  selection,
  enabled,
  takeCount
}: {
  candidateGroups: ProcessedSegmentCandidate[][];
  pairwiseSeamScoreMatrix: MultiTakeOptimizationManifest["pairwiseSeamScoreMatrix"];
  selection: MultiTakePathSelection;
  enabled: boolean;
  takeCount: number;
}): MultiTakeOptimizationManifest {
  const candidates: MultiTakeCandidateManifest[][] = candidateGroups.map(
    (group, segmentIndex) =>
      group.map((candidate) => {
        const manifestSegment = candidate.processedSegment.manifestSegment;

        return {
          segmentIndex: manifestSegment.segmentIndex,
          candidateIndex: candidate.candidateIndex,
          generationAttempt: manifestSegment.generationAttempt,
          selected: selection.chosenPath[segmentIndex] === candidate.candidateIndex,
          candidatePenaltyScore: candidate.candidatePenaltyScore,
          candidatePenaltyReasons: candidate.candidatePenaltyReasons,
          contextOverlapUsed: manifestSegment.contextOverlapUsed,
          contextFallbackUsed: manifestSegment.contextFallbackUsed,
          contextAudioTrimmed: manifestSegment.contextAudioTrimmed,
          contextAudioTrimSeconds: manifestSegment.contextAudioTrimSeconds,
          contextAudioTrimEstimatedSeconds:
            manifestSegment.contextAudioTrimEstimatedSeconds ?? null,
          contextAudioTrimSearch: manifestSegment.contextAudioTrimSearch ?? null,
          leveledMetrics: manifestSegment.leveledMetrics
        };
      })
  );

  return {
    enabled,
    takeCount,
    candidateCounts: candidates.map((group) => group.length),
    candidates,
    pairwiseSeamScoreMatrix,
    baselinePath: selection.baselinePath,
    chosenPath: selection.chosenPath,
    baselineTotalScore: selection.baselineTotalScore,
    chosenTotalScore: selection.chosenTotalScore,
    chosenTotalScoreAfterAdjustments: selection.chosenTotalScore,
    improvementPercentage: selection.improvementPercentage,
    worstSeamBefore: selection.baselineWorstSeam,
    worstSeamAfter: selection.chosenWorstSeam,
    worstSeamImprovementPercentage: selection.worstSeamImprovementPercentage,
    finalPublishabilityVerdict: evaluateSegmentedPublishability({
      boundaries: [],
      multiTakeEnabled: enabled,
      improvementPercentage: selection.improvementPercentage,
      worstSeamImprovementPercentage: selection.worstSeamImprovementPercentage,
      durationSeconds: null
    })
  };
}

function finalizeMultiTakeOptimizationManifest({
  multiTakeOptimization,
  boundaries,
  durationSeconds
}: {
  multiTakeOptimization: MultiTakeOptimizationManifest;
  boundaries: SegmentBoundaryDiagnostic[];
  durationSeconds: number | null;
}): MultiTakeOptimizationManifest {
  const chosenTotalScoreAfterAdjustments = roundToTwoDecimals(
    multiTakeOptimization.chosenPath.reduce((total, candidateIndex, segmentIndex) => {
      const candidate = multiTakeOptimization.candidates[segmentIndex]?.find(
        (entry) => entry.candidateIndex === candidateIndex
      );
      return total + (candidate?.candidatePenaltyScore ?? 0);
    }, 0) + boundaries.reduce((total, boundary) => total + boundary.seamQualityScore, 0)
  );

  return {
    ...multiTakeOptimization,
    chosenTotalScoreAfterAdjustments,
    worstSeamAfter: findWorstFinalBoundaryForPath(
      boundaries,
      multiTakeOptimization.chosenPath
    ),
    finalPublishabilityVerdict: evaluateSegmentedPublishability({
      boundaries,
      multiTakeEnabled: multiTakeOptimization.enabled,
      improvementPercentage: multiTakeOptimization.improvementPercentage,
      worstSeamImprovementPercentage:
        multiTakeOptimization.worstSeamImprovementPercentage,
      durationSeconds
    })
  };
}

function findWorstFinalBoundaryForPath(
  boundaries: SegmentBoundaryDiagnostic[],
  chosenPath: number[]
): MultiTakeOptimizationManifest["worstSeamAfter"] {
  const worstBoundary = boundaries
    .slice()
    .sort((left, right) => right.seamQualityScore - left.seamQualityScore)[0];

  if (!worstBoundary) {
    return null;
  }

  return {
    boundaryIndex: worstBoundary.boundaryIndex,
    score: worstBoundary.seamQualityScore,
    seamFailureKind: worstBoundary.seamFailureKind,
    seamFailureReason: worstBoundary.seamFailureReason,
    leftCandidateIndex: chosenPath[worstBoundary.previousSegmentIndex - 1] ?? 0,
    rightCandidateIndex: chosenPath[worstBoundary.nextSegmentIndex - 1] ?? 0
  };
}

function toProcessedSegmentCandidate(
  processedSegment: ProcessedSegment,
  candidateIndex: number
): ProcessedSegmentCandidate {
  const penalty = computeMultiTakeCandidatePenalty({
    metrics: processedSegment.manifestSegment.leveledMetrics,
    generationAttempt: processedSegment.manifestSegment.generationAttempt,
    contextFallbackUsed: processedSegment.manifestSegment.contextFallbackUsed,
    contextAudioTrimmed: processedSegment.manifestSegment.contextAudioTrimmed,
    contextAudioTrimSeconds: processedSegment.manifestSegment.contextAudioTrimSeconds
  });

  return {
    candidateIndex,
    processedSegment,
    candidatePenaltyScore: penalty.score,
    candidatePenaltyReasons: penalty.reasons
  };
}

function sumSegmentDurationSeconds(
  manifestSegments: SegmentDiagnosticsManifestSegment[],
  joinPlan: SegmentJoinPlan[]
): number | null {
  let durationSeconds = 0;

  for (const segment of manifestSegments) {
    const segmentDuration = segment.leveledMetrics.durationSeconds;

    if (segmentDuration === null) {
      return null;
    }

    durationSeconds += segmentDuration;
  }

  for (const join of joinPlan) {
    durationSeconds += join.pauseMs / 1000;
  }

  return roundToTwoDecimals(durationSeconds);
}

async function persistSegmentDebugArtifact({
  sourcePath,
  debugArtifactDirectoryPath,
  segmentNumber,
  attempt,
  kind
}: {
  sourcePath: string;
  debugArtifactDirectoryPath: string;
  segmentNumber: number;
  attempt: number;
  kind: "raw" | "standardized" | "leveled" | "seam-adjusted";
}): Promise<void> {
  await persistAudioDebugArtifact({
    sourcePath,
    directoryPath: debugArtifactDirectoryPath,
    filename: `${kind}-segment-${String(segmentNumber).padStart(3, "0")}${
      attempt > 1 ? `-attempt-${attempt}` : ""
    }.wav`,
    note: `${kind} segmented Mistral WAV artifact.`
  });
}

async function persistSeamDebugArtifacts({
  assembledPath,
  debugArtifactDirectoryPath,
  boundaries,
  smoothJoins
}: {
  assembledPath: string;
  debugArtifactDirectoryPath: string;
  boundaries: SegmentBoundaryDiagnostic[];
  smoothJoins: boolean;
}): Promise<void> {
  for (const boundary of boundaries) {
    if (boundary.boundaryTimestampSeconds === null) {
      continue;
    }

    const filename = `seam-${String(boundary.boundaryIndex).padStart(3, "0")}.wav`;
    const outputPath = path.join(debugArtifactDirectoryPath, filename);

    await extractAudioClip({
      inputPath: assembledPath,
      outputPath,
      startSeconds: boundary.boundaryTimestampSeconds - 3,
      durationSeconds: 6 + (smoothJoins ? boundary.gapDurationMs / 1000 : 0)
    });

    boundary.seamClipPath = outputPath;

    console.info(
      "[audio-debug] artifact",
      JSON.stringify({
        filename,
        path: outputPath,
        note: "Short merged-audio clip around a leveled segment boundary."
      })
    );
  }
}

async function persistSegmentedDiagnosticsManifest({
  debugArtifactDirectoryPath,
  manifest
}: {
  debugArtifactDirectoryPath: string;
  manifest: SegmentDiagnosticsManifest;
}): Promise<void> {
  const filename = "segmented-audio-manifest.json";
  const outputPath = path.join(debugArtifactDirectoryPath, filename);

  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.info(
    "[audio-debug] artifact",
    JSON.stringify({
      filename,
      path: outputPath,
      note: "Segmented generation metrics, gain, boundary, and warning manifest."
    })
  );
}

function logSegmentedBoundaryDiagnostics(boundaries: SegmentBoundaryDiagnostic[]): void {
  if (boundaries.length === 0) {
    return;
  }

  const largestBoundaryDelta = boundaries
    .filter((boundary) => boundary.deltaLufs !== null)
    .sort((left, right) => (right.deltaLufs ?? 0) - (left.deltaLufs ?? 0))[0];

  console.info(
    "[segmented] boundary-diagnostics",
    JSON.stringify({
      totalBoundaries: boundaries.length,
      largestBoundaryDelta: largestBoundaryDelta
        ? {
            boundaryIndex: largestBoundaryDelta.boundaryIndex,
            deltaLufs: largestBoundaryDelta.deltaLufs,
            boundaryTimestampSeconds: largestBoundaryDelta.boundaryTimestampSeconds
          }
        : null,
      boundaries: boundaries.map((boundary) => ({
        boundaryIndex: boundary.boundaryIndex,
        boundaryTimestampSeconds: boundary.boundaryTimestampSeconds,
        nextSpeechTimestampSeconds: boundary.nextSpeechTimestampSeconds,
        gapDurationMs: boundary.gapDurationMs,
        beforeLoudness: boundary.beforeLoudness,
        afterLoudness: boundary.afterLoudness,
        deltaLufs: boundary.deltaLufs,
        previousLast2sRmsDb: boundary.previousLast2sRmsDb,
        nextFirst2sRmsDb: boundary.nextFirst2sRmsDb,
        rmsDeltaDb: boundary.rmsDeltaDb,
        spectralDifferenceScore: boundary.spectralDifferenceScore,
        speakingRateDeltaWps: boundary.speakingRateDeltaWps,
        toneMismatchScore: boundary.toneMismatchScore,
        seamFailureKind: boundary.seamFailureKind,
        seamFailureReason: boundary.seamFailureReason,
        contextOverlapUsed: boundary.contextOverlapUsed,
        regenerationAttempts: boundary.regenerationAttempts.length,
        boundaryRepair: boundary.boundaryRepair,
        speechCutoffRiskBefore: boundary.speechCutoffRiskBefore,
        speechCutoffRiskAfter: boundary.speechCutoffRiskAfter,
        seamQualityScore: boundary.seamQualityScore,
        seamPassed: boundary.seamPassed,
        exceedsThreshold: boundary.exceedsThreshold,
        nearBoundaryJumpExceedsThreshold: boundary.nearBoundaryJumpExceedsThreshold
      }))
    })
  );
}

function logSegmentedDiagnosticsWarnings(warnings: SegmentDiagnosticsWarning[]): void {
  if (warnings.length === 0) {
    console.info(
      "[segmented] diagnostics",
      JSON.stringify({
        warnings: 0
      })
    );
    return;
  }

  console.warn(
    "[segmented] diagnostics warnings",
    JSON.stringify({
      warnings
    })
  );
}

function logPublishabilityVerdict(
  multiTakeOptimization: MultiTakeOptimizationManifest
): void {
  const verdict = multiTakeOptimization.finalPublishabilityVerdict;
  const payload = {
    publishable: verdict.publishable,
    reason: verdict.reason,
    killCriteriaFailures: verdict.killCriteriaFailures,
    enabled: multiTakeOptimization.enabled,
    takeCount: multiTakeOptimization.takeCount,
    baselineTotalScore: multiTakeOptimization.baselineTotalScore,
    chosenTotalScore: multiTakeOptimization.chosenTotalScore,
    chosenTotalScoreAfterAdjustments:
      multiTakeOptimization.chosenTotalScoreAfterAdjustments,
    improvementPercentage: multiTakeOptimization.improvementPercentage,
    worstSeamBefore: multiTakeOptimization.worstSeamBefore,
    worstSeamAfter: multiTakeOptimization.worstSeamAfter
  };

  if (verdict.publishable) {
    console.info("[segmented] publishability", JSON.stringify(payload));
    return;
  }

  console.warn("[segmented] publishability", JSON.stringify(payload));
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

function buildSpokenContextOverlapInput({
  previousContext,
  targetText
}: {
  previousContext: string;
  targetText: string;
}): {
  input: string;
  inputWordCount: number;
  contextWordCount: number;
} {
  const input = `${previousContext.trim()}\n\n${targetText.trim()}`.trim();

  return {
    input,
    inputWordCount: countRouteWords(input),
    contextWordCount: countRouteWords(previousContext)
  };
}

function estimateContextAudioTrimSeconds({
  durationSeconds,
  contextWordCount,
  targetWordCount
}: {
  durationSeconds: number;
  contextWordCount: number;
  targetWordCount: number;
}): number {
  const totalWords = Math.max(1, contextWordCount + targetWordCount);
  const estimated = durationSeconds * (contextWordCount / totalWords);
  const pauseAllowanceSeconds = 0.08;
  return roundToThreeDecimals(
    Math.min(Math.max(0, estimated + pauseAllowanceSeconds), Math.max(0, durationSeconds - 0.5))
  );
}

function isContextTrimLikelyBadTake(
  metrics: Awaited<ReturnType<typeof measureSegmentAudioFile>>
): boolean {
  if (metrics.integratedLoudness === null || metrics.truePeak === null) {
    return false;
  }

  const desiredGainDb =
    SEGMENT_LEVELING_SETTINGS.integratedLoudness - metrics.integratedLoudness;
  const peakLimitedGainDb = SEGMENT_LEVELING_SETTINGS.truePeak - metrics.truePeak;
  const gainShortfallDb = desiredGainDb - peakLimitedGainDb;

  return gainShortfallDb > 4 || (metrics.internalDriftLufs ?? 0) > 8;
}

function countRouteWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function roundToThreeDecimals(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

function truncate(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength)}...`;
}

function readBooleanEnv(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  return /^(1|true|yes|on)$/i.test(value);
}

function readPositiveIntegerEnv(value: string | undefined, defaultValue: number): number {
  const parsed = Number.parseInt(value ?? "", 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return defaultValue;
  }

  return parsed;
}
