import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AudioProcessingError,
  buildSegmentBoundaryDiagnostics,
  buildSegmentJoinPlan,
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_VOLUME_BOOST,
  getFileExtension,
  getMimeType,
  levelSegmentAudioFile,
  masterAudioFile,
  measureSegmentAudioFile,
  mergeAudioFiles,
  resolveMasteringStrategy,
  standardizeSegmentAudioFile,
  transcodeAudioFile,
  type AudioMasteringResult,
  type OutputFormat,
  type SegmentBoundaryDiagnostic,
  type SegmentAudioMetrics,
  type VolumeBoost
} from "@/lib/audio";
import {
  generateVoxcpmSpeech,
  resolveVoxcpmGenerationDefaults,
  resolveVoxcpmConfig,
  type VoxcpmCloneMode
} from "@/lib/voxcpm";
import { prepareTextForSpeech, slugifyFilename } from "@/lib/text";
import {
  chunkTextForVoxcpm,
  createVoxcpmSegmentPromptPlan,
  hashPrivateText
} from "@/lib/voxcpm-generation";
import {
  createVoiceLabRunWorkspace,
  loadVoiceReference,
  type VoiceLabRunWorkspace
} from "@/lib/voice-reference-store";
import type { StreamEvent } from "@/lib/generation-progress";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

type ProcessedVoxcpmSegment = {
  segmentNumber: number;
  textHash: string;
  wordCount: number;
  promptSource: "none" | "reference" | "previous-segment";
  rawFilename: string;
  standardizedFilename: string;
  leveledFilename: string;
  rawPath: string;
  standardizedPath: string;
  leveledPath: string;
  rawMetrics: SegmentAudioMetrics;
  standardizedMetrics: SegmentAudioMetrics;
  leveledMetrics: SegmentAudioMetrics;
};

export async function POST(request: Request): Promise<Response> {
  let payload: {
    title?: unknown;
    text?: unknown;
    cloneMode?: unknown;
    normalizationEnabled?: unknown;
    volumeBoost?: unknown;
    outputFormat?: unknown;
  };

  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const title = typeof payload.title === "string" ? payload.title : "";
  const text = typeof payload.text === "string" ? payload.text : "";
  const cloneMode: VoxcpmCloneMode = payload.cloneMode === "reference" ? "reference" : "ultimate";
  const normalizationEnabled = payload.normalizationEnabled !== false;
  const volumeBoost =
    payload.volumeBoost === "normal" ||
    payload.volumeBoost === "louder" ||
    payload.volumeBoost === "very-loud"
      ? payload.volumeBoost
      : DEFAULT_VOLUME_BOOST;
  const outputFormat: OutputFormat = DEFAULT_OUTPUT_FORMAT;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void runVoxcpmGeneration({
        controller,
        title,
        text,
        cloneMode,
        normalizationEnabled,
        volumeBoost,
        outputFormat
      });
    }
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Accel-Buffering": "no"
    }
  });
}

async function runVoxcpmGeneration({
  controller,
  title,
  text,
  cloneMode,
  normalizationEnabled,
  volumeBoost,
  outputFormat
}: {
  controller: ReadableStreamDefaultController<Uint8Array>;
  title: string;
  text: string;
  cloneMode: VoxcpmCloneMode;
  normalizationEnabled: boolean;
  volumeBoost: VolumeBoost;
  outputFormat: OutputFormat;
}): Promise<void> {
  const encoder = new TextEncoder();
  const sendEvent = async (event: StreamEvent) => {
    controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };

  try {
    if (!text.trim()) {
      throw new Error("Paste some text before generating audio.");
    }

    await sendEvent({
      type: "progress",
      stage: "started",
      message: "Generation started",
      completedSegments: 0
    });

    const voxcpmConfig = resolveVoxcpmConfig();
    const generationDefaults = resolveVoxcpmGenerationDefaults();
    const reference = await loadVoiceReference();

    if (!reference) {
      throw new Error("Save reference audio and its exact transcript before using VoxCPM2.");
    }

    await sendEvent({
      type: "progress",
      stage: "cleaning",
      message: "Cleaning text",
      completedSegments: 0
    });

    const preparedText = prepareTextForSpeech(text);

    if (!preparedText.cleanedText) {
      throw new Error("The cleaned text is empty. Paste longer plain-language content.");
    }

    const segments = chunkTextForVoxcpm(preparedText.paragraphs);

    if (segments.length === 0) {
      throw new Error("No narration segments were created after cleaning.");
    }

    const runWorkspace = await createVoiceLabRunWorkspace();
    const isLongForm = segments.length > 1;
    const promptPlan = createVoxcpmSegmentPromptPlan({
      segments,
      referenceTranscript: reference.transcript,
      cloneMode,
      forceFirstPrompt: isLongForm
    });

    await sendEvent({
      type: "progress",
      stage: "segmenting",
      message: isLongForm ? "Preparing VoxCPM2 long-form generation" : "Preparing VoxCPM2 clone",
      totalSegments: promptPlan.length,
      completedSegments: 0
    });

    const processedSegments: ProcessedVoxcpmSegment[] = [];
    let previousRawPath: string | null = null;

    for (const plan of promptPlan) {
      const segmentId = String(plan.segmentNumber).padStart(3, "0");
      const rawPath = path.join(runWorkspace.segmentsDirectoryPath, `segment-${segmentId}-raw.wav`);
      const standardizedPath = path.join(
        runWorkspace.segmentsDirectoryPath,
        `segment-${segmentId}-standardized.wav`
      );
      const leveledPath = path.join(
        runWorkspace.segmentsDirectoryPath,
        `segment-${segmentId}-leveled.wav`
      );
      const promptAudioPath =
        plan.promptSource === "reference"
          ? reference.referenceAudioPath
          : plan.promptSource === "previous-segment"
            ? previousRawPath ?? undefined
            : undefined;

      await sendEvent({
        type: "progress",
        stage: "section-started",
        message: `Section ${plan.segmentNumber} of ${promptPlan.length} started`,
        currentSegment: plan.segmentNumber,
        totalSegments: promptPlan.length,
        completedSegments: plan.segmentNumber - 1
      });

      const audioBuffer = await generateVoxcpmSpeech({
        text: plan.text,
        referenceAudioPath: reference.referenceAudioPath,
        promptAudioPath,
        promptText: plan.promptText ?? undefined,
        endpointUrl: voxcpmConfig.endpointUrl,
        apiKey: voxcpmConfig.apiKey,
        endpointMode: voxcpmConfig.endpointMode,
        timeoutMs: voxcpmConfig.timeoutMs,
        cfgValue: generationDefaults.cfgValue,
        inferenceTimesteps: generationDefaults.inferenceTimesteps,
        normalize: generationDefaults.normalize,
        denoise: generationDefaults.denoise
      });

      await writeFile(rawPath, audioBuffer);

      await sendEvent({
        type: "progress",
        stage: "section-raw-received",
        message: `Section ${plan.segmentNumber} of ${promptPlan.length} raw WAV received`,
        currentSegment: plan.segmentNumber,
        totalSegments: promptPlan.length,
        completedSegments: plan.segmentNumber - 1
      });

      const rawMetrics = await measureSegmentAudioFile(rawPath);

      await standardizeSegmentAudioFile({
        inputPath: rawPath,
        outputPath: standardizedPath
      });

      await sendEvent({
        type: "progress",
        stage: "section-standardized",
        message: `Section ${plan.segmentNumber} of ${promptPlan.length} standardized`,
        currentSegment: plan.segmentNumber,
        totalSegments: promptPlan.length,
        completedSegments: plan.segmentNumber - 1
      });

      const standardizedMetrics = await measureSegmentAudioFile(standardizedPath);
      await levelSegmentAudioFile({
        inputPath: standardizedPath,
        outputPath: leveledPath,
        metrics: standardizedMetrics
      });
      const leveledMetrics = await measureSegmentAudioFile(leveledPath, {
        includeEdgeTone: true
      });

      await sendEvent({
        type: "progress",
        stage: "section-leveled",
        message: `Section ${plan.segmentNumber} of ${promptPlan.length} standardized and leveled`,
        currentSegment: plan.segmentNumber,
        totalSegments: promptPlan.length,
        completedSegments: plan.segmentNumber
      });

      processedSegments.push({
        segmentNumber: plan.segmentNumber,
        textHash: hashPrivateText(plan.text),
        wordCount: plan.wordCount,
        promptSource: plan.promptSource,
        rawFilename: path.basename(rawPath),
        standardizedFilename: path.basename(standardizedPath),
        leveledFilename: path.basename(leveledPath),
        rawPath,
        standardizedPath,
        leveledPath,
        rawMetrics,
        standardizedMetrics,
        leveledMetrics
      });
      previousRawPath = rawPath;
    }

    const assembledPath = await assembleSegments({
      processedSegments,
      runWorkspace,
      sendEvent
    });
    const filename = `${slugifyFilename(title, "voxcpm-voice-lab")}.${getFileExtension(outputFormat)}`;
    const deliverPath = path.join(runWorkspace.finalDirectoryPath, filename);
    const finalizedOutput = await finalizeVoxcpmOutput({
      assembledPath,
      deliverPath,
      outputFormat,
      normalizationEnabled,
      volumeBoost,
      totalSegments: processedSegments.length,
      sendEvent
    });
    const joinPlan = buildSegmentJoinPlan(
      segments.map((segment) => segment.text),
      false
    );
    const boundaries = buildSegmentBoundaryDiagnostics(
      processedSegments.map((segment) => segment.leveledMetrics),
      joinPlan.map((join) => join.pauseMs / 1000),
      undefined,
      undefined,
      {
        wordCounts: segments.map((segment) => segment.wordCount),
        toneSeamScoringEnabled: true
      }
    );

    await persistSanitizedManifest({
      runWorkspace,
      filename,
      cloneMode,
      outputFormat,
      textHash: hashPrivateText(preparedText.cleanedText),
      wordCount: preparedText.wordCount,
      processedSegments,
      boundaries,
      normalizationApplied: finalizedOutput.normalizationApplied,
      normalizationFallbackUsed: finalizedOutput.normalizationFallbackUsed,
      masteringResult: finalizedOutput.masteringResult
    });

    const audioBuffer = await readFile(finalizedOutput.deliverPath);

    await sendEvent({
      type: "progress",
      stage: "final-ready",
      message: "Final MP3 ready",
      totalSegments: processedSegments.length,
      completedSegments: processedSegments.length
    });

    await sendEvent({
      type: "complete",
      filename,
      audioBase64: audioBuffer.toString("base64"),
      mimeType: getMimeType(outputFormat),
      outputFormat,
      normalizationApplied: finalizedOutput.normalizationApplied,
      normalizationFallbackUsed: finalizedOutput.normalizationFallbackUsed,
      strategy: isLongForm ? "voxcpm-long-form" : "voxcpm-short",
      totalSegments: processedSegments.length
    });
  } catch (error) {
    const safeMessage = describeSafeError(error);

    await sendEvent({
      type: "progress",
      stage: "failed",
      message: safeMessage
    });

    await sendEvent({
      type: "error",
      message: safeMessage
    });
  } finally {
    controller.close();
  }
}

async function assembleSegments({
  processedSegments,
  runWorkspace,
  sendEvent
}: {
  processedSegments: ProcessedVoxcpmSegment[];
  runWorkspace: VoiceLabRunWorkspace;
  sendEvent: (event: StreamEvent) => Promise<void>;
}): Promise<string> {
  if (processedSegments.length === 1) {
    return processedSegments[0].leveledPath;
  }

  const mergedPath = path.join(runWorkspace.runDirectoryPath, "merged-premaster.wav");

  await sendEvent({
    type: "progress",
    stage: "merge-started",
    message: "Merge started",
    totalSegments: processedSegments.length,
    completedSegments: processedSegments.length
  });

  await mergeAudioFiles({
    inputPaths: processedSegments.map((segment) => segment.leveledPath),
    outputPath: mergedPath,
    outputFormat: "wav",
    strategy: "copy"
  });

  return mergedPath;
}

async function finalizeVoxcpmOutput({
  assembledPath,
  deliverPath,
  outputFormat,
  normalizationEnabled,
  volumeBoost,
  totalSegments,
  sendEvent
}: {
  assembledPath: string;
  deliverPath: string;
  outputFormat: OutputFormat;
  normalizationEnabled: boolean;
  volumeBoost: VolumeBoost;
  totalSegments: number;
  sendEvent: (event: StreamEvent) => Promise<void>;
}): Promise<{
  deliverPath: string;
  normalizationApplied: boolean;
  normalizationFallbackUsed: boolean;
  masteringResult: AudioMasteringResult | null;
}> {
  if (!normalizationEnabled) {
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
      normalizationFallbackUsed: false,
      masteringResult: null
    };
  }

  await sendEvent({
    type: "progress",
    stage: "mastering-started",
    message: "Mastering started",
    totalSegments,
    completedSegments: totalSegments
  });

  try {
    const masteringResult = await masterAudioFile({
      inputPath: assembledPath,
      outputPath: deliverPath,
      outputFormat,
      volumeBoost,
      strategy: resolveMasteringStrategy(process.env.VOICE_LAB_MASTERING_STRATEGY)
    });

    return {
      deliverPath,
      normalizationApplied: true,
      normalizationFallbackUsed: false,
      masteringResult
    };
  } catch (error) {
    const fallbackPath = deliverPath.replace(
      new RegExp(`\\.${getFileExtension(outputFormat)}$`),
      `-unmastered.${getFileExtension(outputFormat)}`
    );
    await transcodeAudioFile({
      inputPath: assembledPath,
      outputPath: fallbackPath,
      outputFormat,
      applyLoudnorm: false,
      stage: "encoding"
    });

    return {
      deliverPath: fallbackPath,
      normalizationApplied: false,
      normalizationFallbackUsed: true,
      masteringResult: null
    };
  }
}

async function persistSanitizedManifest({
  runWorkspace,
  filename,
  cloneMode,
  outputFormat,
  textHash,
  wordCount,
  processedSegments,
  boundaries,
  normalizationApplied,
  normalizationFallbackUsed,
  masteringResult
}: {
  runWorkspace: VoiceLabRunWorkspace;
  filename: string;
  cloneMode: VoxcpmCloneMode;
  outputFormat: OutputFormat;
  textHash: string;
  wordCount: number;
  processedSegments: ProcessedVoxcpmSegment[];
  boundaries: SegmentBoundaryDiagnostic[];
  normalizationApplied: boolean;
  normalizationFallbackUsed: boolean;
  masteringResult: AudioMasteringResult | null;
}): Promise<void> {
  const manifest = {
    version: 1,
    engine: "voxcpm2",
    endpointMode: process.env.VOXCPM_ENDPOINT_MODE?.trim() || "native-wrapper",
    runId: runWorkspace.runId,
    createdAt: new Date().toISOString(),
    cloneMode,
    outputFormat,
    finalFilename: filename,
    input: {
      textSha256: textHash,
      wordCount
    },
    segments: processedSegments.map((segment) => ({
      segmentNumber: segment.segmentNumber,
      textSha256: segment.textHash,
      wordCount: segment.wordCount,
      promptSource: segment.promptSource,
      rawFilename: segment.rawFilename,
      standardizedFilename: segment.standardizedFilename,
      leveledFilename: segment.leveledFilename,
      rawMetrics: sanitizeSegmentMetrics(segment.rawMetrics),
      standardizedMetrics: sanitizeSegmentMetrics(segment.standardizedMetrics),
      leveledMetrics: sanitizeSegmentMetrics(segment.leveledMetrics)
    })),
    boundaries: boundaries.map((boundary) => ({
      boundaryIndex: boundary.boundaryIndex,
      deltaLufs: boundary.deltaLufs,
      nearBoundaryJumpLufs: boundary.nearBoundaryJumpLufs,
      seamQualityScore: boundary.seamQualityScore,
      seamPassed: boundary.seamPassed,
      gapDurationMs: boundary.gapDurationMs
    })),
    final: {
      normalizationApplied,
      normalizationFallbackUsed,
      masteringMetrics: masteringResult?.metrics ?? null,
      masteringStrategy: masteringResult?.strategy ?? null,
      masteringExecutionMode: masteringResult?.executionMode ?? null
    }
  };

  await writeFile(runWorkspace.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function sanitizeSegmentMetrics(metrics: SegmentAudioMetrics): Record<string, unknown> {
  return {
    durationSeconds: metrics.durationSeconds,
    integratedLoudness: metrics.integratedLoudness,
    truePeak: metrics.truePeak,
    loudnessRange: metrics.loudnessRange,
    firstWindowLoudness: metrics.firstWindowLoudness,
    lastWindowLoudness: metrics.lastWindowLoudness,
    internalDriftLufs: metrics.internalDriftLufs
  };
}

function describeSafeError(error: unknown): string {
  if (error instanceof AudioProcessingError) {
    return sanitizeErrorMessage(error.message);
  }

  if (error instanceof Error) {
    return sanitizeErrorMessage(error.message);
  }

  return "Unexpected error during VoxCPM2 generation.";
}

function sanitizeErrorMessage(message: string): string {
  const sanitized = redactPrivatePaths(message)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !/authorization|bearer|base64|data:audio/i.test(line) &&
        !/^ffmpeg version /i.test(line) &&
        !/^built with /i.test(line) &&
        !/^configuration:/i.test(line) &&
        !/^libav[a-z]+\s+/i.test(line)
    )
    .join(" ")
    .slice(0, 300);

  return sanitized || "Unexpected error during VoxCPM2 generation.";
}

function redactPrivatePaths(message: string): string {
  return message.replace(/(?:\/Users|\/private\/var|\/var|\/tmp)\/[^\s'"]+/g, "[private-path]");
}
