import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type OutputFormat = "mp3" | "wav";
export type VolumeBoost = "normal" | "louder" | "very-loud";
export type AudioProcessingStage =
  | "availability-check"
  | "segment-normalization"
  | "merge"
  | "join-smoothing"
  | "premaster"
  | "final-normalization"
  | "measurement"
  | "encoding";

export type MasteringStrategy =
  | "current-static-master"
  | "speech-leveler"
  | "raw-debug-only";

type MasteringExecutionMode =
  | "linear-loudnorm"
  | "static-gain-limited"
  | "speech-leveler"
  | "raw-debug-only";

type MergeStrategy = "copy" | "reencode";
type LoudnessSettings = {
  integratedLoudness: number;
  truePeak: number;
  limiter: number;
};

type LoudnormMeasurement = {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
};

type LoudnormStats = {
  input_i?: string;
  input_tp?: string;
  input_lra?: string;
  input_thresh?: string;
  target_offset?: string;
  output_i?: string;
  output_tp?: string;
  normalization_type?: string;
};

export type SegmentLevelingSettings = {
  integratedLoudness: number;
  truePeak: number;
  limiter: number;
  maxBoostDb: number;
  maxCutDb: number;
  maxDriftCorrectionDb: number;
  driftCorrectionThresholdLufs: number;
};

export type AudioLoudnessMetrics = {
  integratedLoudness: number | null;
  truePeak: number | null;
  maxVolume: number | null;
  measurementMode: "loudnorm" | "volumedetect";
};

export type AudioMasteringResult = {
  metrics: AudioLoudnessMetrics | null;
  preMasterMetrics: AudioLoudnessMetrics | null;
  strategy: MasteringStrategy;
  executionMode: MasteringExecutionMode;
  appliedGainDb: number | null;
};

export type AudioLoudnessTimelinePoint = {
  seconds: number;
  shortTermLufs: number;
};

export type AudioLoudnessJump = {
  fromSeconds: number;
  toSeconds: number;
  fromShortTermLufs: number;
  toShortTermLufs: number;
  deltaLufs: number;
};

export type AudioLoudnessTimeline = {
  durationSeconds: number | null;
  integratedLoudness: number | null;
  truePeak: number | null;
  loudnessRange: number | null;
  shortTermByTimestamp: AudioLoudnessTimelinePoint[];
  largestJumps: AudioLoudnessJump[];
};

export type SegmentAudioMetrics = {
  durationSeconds: number | null;
  integratedLoudness: number | null;
  truePeak: number | null;
  maxVolume: number | null;
  loudnessRange: number | null;
  shortTermByTimestamp: AudioLoudnessTimelinePoint[];
  firstWindowLoudness: number | null;
  lastWindowLoudness: number | null;
  largestInternalJump: AudioLoudnessJump | null;
  internalDriftLufs: number | null;
};

export type SegmentLevelingResult = {
  appliedGainDb: number;
  driftCorrectionDb: number;
  filter: string;
};

export type SegmentBoundaryDiagnostic = {
  boundaryIndex: number;
  previousSegmentIndex: number;
  nextSegmentIndex: number;
  boundaryTimestampSeconds: number | null;
  nextSpeechTimestampSeconds: number | null;
  beforeLoudness: number | null;
  afterLoudness: number | null;
  deltaLufs: number | null;
  exceedsThreshold: boolean;
  nearBoundaryJumpLufs: number | null;
  nearBoundaryJumpExceedsThreshold: boolean;
};

export type SegmentDiagnosticsWarning = {
  code:
    | "boundary-delta"
    | "near-boundary-jump"
    | "segment-internal-drift"
    | "final-true-peak"
    | "final-metrics-missing";
  message: string;
  segmentIndex?: number;
  boundaryIndex?: number;
  value?: number;
  threshold?: number;
};

export type SegmentDiagnosticsManifestSegment = {
  segmentIndex: number;
  wordCount: number;
  rawMetrics: SegmentAudioMetrics;
  standardizedMetrics: SegmentAudioMetrics;
  leveledMetrics: SegmentAudioMetrics;
  appliedGainDb: number;
  driftCorrectionDb: number;
  levelingFilter: string;
};

export type SegmentDiagnosticsManifest = {
  version: 1;
  createdAt: string;
  totalSegments: number;
  smoothJoins: boolean;
  joinPauseMs: number;
  segmentLeveling: SegmentLevelingSettings;
  segments: SegmentDiagnosticsManifestSegment[];
  boundaries: SegmentBoundaryDiagnostic[];
  warnings: SegmentDiagnosticsWarning[];
  finalMetrics: AudioLoudnessMetrics | null;
};

export const DEFAULT_OUTPUT_FORMAT: OutputFormat = "mp3";
export const DEFAULT_VOLUME_BOOST: VolumeBoost = "normal";
export const DEFAULT_SMOOTH_JOINS = true;
export const DEFAULT_JOIN_PAUSE_MS = 300;
export const DEFAULT_MASTERING_STRATEGY: MasteringStrategy = "current-static-master";
export const STANDARD_INTERMEDIATE_SAMPLE_RATE = 24_000;
export const STANDARD_INTERMEDIATE_CHANNELS = 1;
export const TRIM_SILENCE_FILTER =
  "silenceremove=start_periods=1:start_duration=0.02:start_threshold=-45dB:start_silence=0.04:detection=rms,areverse,silenceremove=start_periods=1:start_duration=0.02:start_threshold=-45dB:start_silence=0.08:detection=rms,areverse";
export const SEGMENT_EDGE_FADE_FILTER =
  "afade=t=in:st=0:d=0.006,areverse,afade=t=in:st=0:d=0.006,areverse";
export const SEGMENT_STANDARDIZATION_FILTER = `${TRIM_SILENCE_FILTER},${SEGMENT_EDGE_FADE_FILTER}`;
export const LOUDNORM_FILTER =
  "loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=0.841:level=disabled";
export const SPEECH_PREMASTER_FILTER =
  "highpass=f=70,acompressor=threshold=0.063:ratio=4:attack=2:release=120:makeup=2.51,alimiter=limit=0.708:level=disabled";
export const SPEECH_LEVELER_PREMASTER_FILTER = "highpass=f=70";
export const SPEECH_LEVELER_FILTER =
  "speechnorm=peak=0.9:expansion=1.4:compression=2:raise=0.0005:fall=0.00015:link=1,acompressor=threshold=0.125:ratio=1.35:attack=8:release=140:makeup=1.25";
export const SEGMENT_LEVELING_SETTINGS: SegmentLevelingSettings = {
  integratedLoudness: -18,
  truePeak: -1,
  limiter: getLimiterLimit(-1),
  maxBoostDb: 8,
  maxCutDb: 8,
  maxDriftCorrectionDb: 10,
  driftCorrectionThresholdLufs: 2
};
export const SEGMENT_BOUNDARY_DELTA_WARNING_LU = 2;
export const SEGMENT_NEAR_BOUNDARY_JUMP_WARNING_LU = 3;
export const SEGMENT_INTERNAL_DRIFT_WARNING_LU = 4;
const PREMASTER_INTERMEDIATE_SAMPLE_RATE = 24_000;
const PREMASTER_INTERMEDIATE_CHANNELS = 1;
const LINEAR_LOUDNORM_HEADROOM_DB = 0.2;
export const FFMPEG_MISSING_MESSAGE =
  "ffmpeg executable not found. Checked FFMPEG_PATH, bundled ffmpeg-static, and system ffmpeg on PATH.";

const MP3_BITRATE = "192k";
const FFMPEG_TIMEOUT_MS = 180_000;
const LOUDNESS_MEASUREMENT_FILTER = "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json";
const EBUR128_ANALYSIS_FILTER = "ebur128=peak=true:framelog=verbose";
const MIN_VALID_SHORT_TERM_LUFS = -70;
const PACKAGED_FFMPEG_EXECUTABLE = path.join(
  process.cwd(),
  "node_modules",
  "ffmpeg-static",
  `ffmpeg${process.platform === "win32" ? ".exe" : ""}`
);
const FFMPEG_CANDIDATES = [
  process.env.FFMPEG_PATH?.trim(),
  PACKAGED_FFMPEG_EXECUTABLE,
  process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
].filter((value): value is string => Boolean(value));
const AUDIO_STAGE_LABELS: Record<AudioProcessingStage, string> = {
  "availability-check": "ffmpeg availability check",
  "segment-normalization": "segment normalization",
  merge: "audio merge",
  "join-smoothing": "join smoothing",
  premaster: "speech pre-master",
  "final-normalization": "final normalization",
  measurement: "audio measurement",
  encoding: "audio encoding"
};
const FFMPEG_BANNER_LINE_PATTERNS = [
  /^ffmpeg version /i,
  /^built with /i,
  /^configuration:/i,
  /^libav[a-z]+\s+/i,
  /^(guessed channel layout|input #\d|output #\d)/i
];
const FFMPEG_PROGRESS_LINE_PATTERNS = [/^(size|frame|time|bitrate|speed)=/i, /^video:/i];
const FFMPEG_INTERESTING_LINE_PATTERN =
  /(error|invalid|failed|no such|not found|permission denied|unsafe|unable|could not|impossible|conversion failed|does not contain|unsupported|cannot|not yet|mismatch|corrupt|malformed)/i;
export const VOLUME_BOOST_SETTINGS: Record<VolumeBoost, LoudnessSettings> = {
  normal: {
    integratedLoudness: -16,
    truePeak: -1.5,
    limiter: getLimiterLimit(-1.5)
  },
  louder: {
    integratedLoudness: -14,
    truePeak: -1,
    limiter: getLimiterLimit(-1)
  },
  "very-loud": {
    integratedLoudness: -12.5,
    truePeak: -0.8,
    limiter: getLimiterLimit(-0.8)
  }
};

let ffmpegExecutablePromise: Promise<string> | null = null;

export class AudioProcessingError extends Error {
  stage: AudioProcessingStage;
  executable: string;
  args: string[];
  stderrSummary: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;

  constructor({
    stage,
    executable,
    args,
    stderr,
    exitCode,
    signal,
    timedOut
  }: {
    stage: AudioProcessingStage;
    executable: string;
    args: string[];
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
  }) {
    const stderrSummary = summarizeFfmpegStderr(stderr);
    const message = timedOut
      ? `${AUDIO_STAGE_LABELS[stage]} timed out after ${Math.round(FFMPEG_TIMEOUT_MS / 1000)} seconds.`
      : `${capitalize(AUDIO_STAGE_LABELS[stage])} failed${
          stderrSummary
            ? `: ${stderrSummary}`
            : exitCode !== null
              ? `: ffmpeg exited with code ${exitCode}.`
              : signal
                ? `: ffmpeg exited from signal ${signal}.`
                : "."
        }`;

    super(message);
    this.name = "AudioProcessingError";
    this.stage = stage;
    this.executable = executable;
    this.args = args;
    this.stderrSummary = stderrSummary;
    this.exitCode = exitCode;
    this.signal = signal;
    this.timedOut = timedOut;
  }
}

export function getFileExtension(format: OutputFormat): string {
  return format;
}

export function getMimeType(format: OutputFormat): string {
  return format === "wav" ? "audio/wav" : "audio/mpeg";
}

export async function assertFfmpegAvailable(): Promise<void> {
  await getFfmpegExecutable();
}

export function resolveMasteringStrategy(value: string | undefined | null): MasteringStrategy {
  const normalized = value?.trim().toLowerCase();

  switch (normalized) {
    case "speech-leveler":
      return "speech-leveler";
    case "raw":
    case "raw-debug-only":
      return "raw-debug-only";
    case "static":
    case "current-static-master":
    case "linear-loudnorm":
    case "static-gain-limited":
    case "":
    case undefined:
    case null:
      return DEFAULT_MASTERING_STRATEGY;
    default:
      return DEFAULT_MASTERING_STRATEGY;
  }
}

export async function persistAudioDebugArtifact({
  sourcePath,
  directoryPath,
  filename,
  note
}: {
  sourcePath: string;
  directoryPath: string;
  filename: string;
  note?: string;
}): Promise<string> {
  await mkdir(directoryPath, { recursive: true });

  const targetPath = path.join(directoryPath, filename);
  await copyFile(sourcePath, targetPath);

  console.info(
    "[audio-debug] artifact",
    JSON.stringify({
      filename,
      path: targetPath,
      note: note ?? null
    })
  );

  return targetPath;
}

export async function transcodeAudioFile({
  inputPath,
  outputPath,
  outputFormat,
  applyLoudnorm,
  stage,
  volumeBoost = DEFAULT_VOLUME_BOOST,
  masteringCorrectionDb = 0,
  trimSilence = false,
  sampleRate,
  channels
}: {
  inputPath: string;
  outputPath: string;
  outputFormat: OutputFormat;
  applyLoudnorm: boolean;
  stage?: AudioProcessingStage;
  volumeBoost?: VolumeBoost;
  masteringCorrectionDb?: number;
  trimSilence?: boolean;
  sampleRate?: number;
  channels?: number;
}): Promise<void> {
  await assertAudioFileReady(inputPath);

  await runFfmpeg(
    buildTranscodeArgs({
      inputPath,
      outputPath,
      outputFormat,
      applyLoudnorm,
      volumeBoost,
      masteringCorrectionDb,
      trimSilence,
      sampleRate,
      channels
    }),
    {
      stage: stage ?? (applyLoudnorm ? "final-normalization" : "encoding")
    }
  );

  await assertAudioFileReady(outputPath);
}

export async function standardizeSegmentAudioFile({
  inputPath,
  outputPath
}: {
  inputPath: string;
  outputPath: string;
}): Promise<void> {
  await assertAudioFileReady(inputPath);

  await runFfmpeg(buildSegmentStandardizationArgs({ inputPath, outputPath }), {
    stage: "segment-normalization"
  });

  await assertAudioFileReady(outputPath);
}

export async function levelSegmentAudioFile({
  inputPath,
  outputPath,
  metrics,
  settings = SEGMENT_LEVELING_SETTINGS
}: {
  inputPath: string;
  outputPath: string;
  metrics: Pick<
    SegmentAudioMetrics,
    | "durationSeconds"
    | "integratedLoudness"
    | "truePeak"
    | "firstWindowLoudness"
    | "lastWindowLoudness"
  >;
  settings?: SegmentLevelingSettings;
}): Promise<SegmentLevelingResult> {
  await assertAudioFileReady(inputPath);

  const appliedGainDb = computeSegmentLevelingGainDb(settings, metrics);
  const driftCorrectionDb = computeSegmentDriftCorrectionDb(settings, metrics);
  const filter = buildSegmentLevelingFilter(
    settings,
    appliedGainDb,
    driftCorrectionDb,
    metrics.durationSeconds
  );

  await runFfmpeg(
    buildSegmentLevelingArgs({
      inputPath,
      outputPath,
      filter
    }),
    { stage: "segment-normalization" }
  );

  await assertAudioFileReady(outputPath);

  return {
    appliedGainDb,
    driftCorrectionDb,
    filter
  };
}

export async function extractAudioClip({
  inputPath,
  outputPath,
  startSeconds,
  durationSeconds,
  outputFormat = "wav"
}: {
  inputPath: string;
  outputPath: string;
  startSeconds: number;
  durationSeconds: number;
  outputFormat?: OutputFormat;
}): Promise<void> {
  await assertAudioFileReady(inputPath);

  const start = Math.max(0, startSeconds);
  const duration = Math.max(0.1, durationSeconds);

  await runFfmpeg(
    [
      "-y",
      "-ss",
      start.toFixed(3),
      "-t",
      duration.toFixed(3),
      "-i",
      inputPath,
      "-vn",
      "-ac",
      String(STANDARD_INTERMEDIATE_CHANNELS),
      "-ar",
      String(STANDARD_INTERMEDIATE_SAMPLE_RATE),
      ...getCodecArgs(outputFormat),
      outputPath
    ],
    { stage: "encoding" }
  );

  await assertAudioFileReady(outputPath);
}

export async function mergeAudioFiles({
  inputPaths,
  outputPath,
  outputFormat,
  strategy
}: {
  inputPaths: string[];
  outputPath: string;
  outputFormat: OutputFormat;
  strategy: MergeStrategy;
}): Promise<void> {
  if (inputPaths.length === 0) {
    throw new Error("Audio merge failed: no input segments were provided.");
  }

  for (const inputPath of inputPaths) {
    await assertAudioFileReady(inputPath);
  }

  const listFilePath = path.join(path.dirname(outputPath), `concat-${randomUUID()}.txt`);
  const concatList = inputPaths
    .map((inputPath) => `file '${escapeForFfmpegConcat(path.resolve(inputPath))}'`)
    .join("\n")
    .concat("\n");

  await writeFile(listFilePath, concatList, "utf8");

  try {
    await runFfmpeg(
      buildMergeArgs({
        listFilePath,
        outputPath,
        outputFormat,
        strategy
      }),
      {
        stage: "merge"
      }
    );

    await assertAudioFileReady(outputPath);
  } finally {
    await rm(listFilePath, { force: true });
  }
}

export async function generateSilenceAudioFile({
  outputPath,
  durationMs,
  sampleRate = STANDARD_INTERMEDIATE_SAMPLE_RATE,
  channels = STANDARD_INTERMEDIATE_CHANNELS
}: {
  outputPath: string;
  durationMs: number;
  sampleRate?: number;
  channels?: number;
}): Promise<void> {
  await runFfmpeg(
    buildSilenceArgs({
      outputPath,
      durationMs,
      sampleRate,
      channels
    }),
    {
      stage: "join-smoothing"
    }
  );

  await assertAudioFileReady(outputPath);
}

export async function masterAudioFile({
  inputPath,
  outputPath,
  outputFormat,
  volumeBoost,
  strategy = DEFAULT_MASTERING_STRATEGY,
  debugArtifactDirectoryPath
}: {
  inputPath: string;
  outputPath: string;
  outputFormat: OutputFormat;
  volumeBoost: VolumeBoost;
  strategy?: MasteringStrategy;
  debugArtifactDirectoryPath?: string;
}): Promise<AudioMasteringResult> {
  await assertAudioFileReady(inputPath);

  const settings = VOLUME_BOOST_SETTINGS[volumeBoost];

  if (strategy === "raw-debug-only") {
    return await runRawDebugOnlyMastering({
      inputPath,
      outputPath,
      outputFormat,
      volumeBoost,
      debugArtifactDirectoryPath
    });
  }

  if (strategy === "speech-leveler") {
    try {
      return await runSpeechLevelerMastering({
        inputPath,
        outputPath,
        outputFormat,
        volumeBoost,
        settings,
        debugArtifactDirectoryPath
      });
    } catch (error) {
      console.warn(
        "[mastering] speech-leveler failed; falling back to current static master",
        JSON.stringify({
          volumeBoost,
          reason: error instanceof Error ? error.message : "Unknown speech-leveler failure."
        })
      );
    }
  }

  return await runCurrentStaticMastering({
    inputPath,
    outputPath,
    outputFormat,
    volumeBoost,
    settings,
    debugArtifactDirectoryPath
  });
}

async function runRawDebugOnlyMastering({
  inputPath,
  outputPath,
  outputFormat,
  volumeBoost,
  debugArtifactDirectoryPath
}: {
  inputPath: string;
  outputPath: string;
  outputFormat: OutputFormat;
  volumeBoost: VolumeBoost;
  debugArtifactDirectoryPath?: string;
}): Promise<AudioMasteringResult> {
  await copyOrEncodeAudioWithoutMastering({
    inputPath,
    outputPath,
    outputFormat
  });

  const metrics = await measureAudioFileWithWarning(outputPath, "post-master verification");

  if (debugArtifactDirectoryPath) {
    await persistAudioDebugArtifact({
      sourcePath: outputPath,
      directoryPath: debugArtifactDirectoryPath,
      filename: `final-master-output.${getFileExtension(outputFormat)}`,
      note: "Delivered without mastering because raw-debug-only was selected."
    });
  }

  logMasteringSummary({
    volumeBoost,
    strategy: "raw-debug-only",
    executionMode: "raw-debug-only",
    appliedGainDb: null,
    settings: VOLUME_BOOST_SETTINGS[volumeBoost],
    preMasterMetrics: null,
    metrics
  });

  return {
    metrics,
    preMasterMetrics: null,
    strategy: "raw-debug-only",
    executionMode: "raw-debug-only",
    appliedGainDb: null
  };
}

async function runCurrentStaticMastering({
  inputPath,
  outputPath,
  outputFormat,
  volumeBoost,
  settings,
  debugArtifactDirectoryPath
}: {
  inputPath: string;
  outputPath: string;
  outputFormat: OutputFormat;
  volumeBoost: VolumeBoost;
  settings: LoudnessSettings;
  debugArtifactDirectoryPath?: string;
}): Promise<AudioMasteringResult> {
  const preMasterPath = path.join(path.dirname(outputPath), `premaster-${randomUUID()}.wav`);

  try {
    await applySpeechPreMaster({
      inputPath,
      outputPath: preMasterPath
    });

    if (debugArtifactDirectoryPath) {
      await persistAudioDebugArtifact({
        sourcePath: preMasterPath,
        directoryPath: debugArtifactDirectoryPath,
        filename: "premaster-output.wav",
        note: "Current static mastering pre-master output."
      });
    }

    const preMasterMetrics = await measureAudioFileWithWarning(
      preMasterPath,
      "pre-master verification"
    );
    const measurement = await measureForLinearMastering(preMasterPath, settings);
    const linearFeasible = canLinearLoudnormEngage(measurement, settings);

    let executionMode: MasteringExecutionMode;
    let appliedGainDb: number | null = null;

    if (linearFeasible) {
      const linearFilter = buildLinearMasteringFilter(settings, measurement);

      const { stderr } = await runFfmpegAndCapture(
        [
          "-y",
          "-i",
          preMasterPath,
          "-vn",
          "-af",
          linearFilter,
          ...getCodecArgs(outputFormat),
          outputPath
        ],
        { stage: "final-normalization" }
      );

      await assertAudioFileReady(outputPath);

      const passTwoStats = parseLoudnormStats(stderr);
      const reportedType = passTwoStats?.normalization_type ?? null;

      if (reportedType === "linear") {
        executionMode = "linear-loudnorm";
        appliedGainDb = parseFiniteNumber(measurement.target_offset);
      } else {
        console.warn(
          "[mastering] linear loudnorm did not engage despite headroom; falling back to static gain",
          JSON.stringify({
            volumeBoost,
            reportedType,
            measurement
          })
        );

        const fallbackResult = await applyStaticGainMaster({
          inputPath: preMasterPath,
          outputPath,
          outputFormat,
          settings,
          measurement
        });

        executionMode = "static-gain-limited";
        appliedGainDb = fallbackResult.appliedGainDb;
      }
    } else {
      const fallbackResult = await applyStaticGainMaster({
        inputPath: preMasterPath,
        outputPath,
        outputFormat,
        settings,
        measurement
      });

      executionMode = "static-gain-limited";
      appliedGainDb = fallbackResult.appliedGainDb;
    }

    const metrics = await measureAudioFileWithWarning(outputPath, "post-master verification");

    if (debugArtifactDirectoryPath) {
      await persistAudioDebugArtifact({
        sourcePath: outputPath,
        directoryPath: debugArtifactDirectoryPath,
        filename: `final-master-output.${getFileExtension(outputFormat)}`,
        note: "Current static mastering final delivery."
      });
    }

    logMasteringSummary({
      volumeBoost,
      strategy: "current-static-master",
      executionMode,
      appliedGainDb,
      settings,
      preMasterMetrics,
      metrics
    });

    return {
      metrics,
      preMasterMetrics,
      strategy: "current-static-master",
      executionMode,
      appliedGainDb
    };
  } finally {
    await rm(preMasterPath, { force: true });
  }
}

async function runSpeechLevelerMastering({
  inputPath,
  outputPath,
  outputFormat,
  volumeBoost,
  settings,
  debugArtifactDirectoryPath
}: {
  inputPath: string;
  outputPath: string;
  outputFormat: OutputFormat;
  volumeBoost: VolumeBoost;
  settings: LoudnessSettings;
  debugArtifactDirectoryPath?: string;
}): Promise<AudioMasteringResult> {
  const preMasterPath = path.join(path.dirname(outputPath), `speech-leveler-premaster-${randomUUID()}.wav`);
  const speechLeveledPath = path.join(
    path.dirname(outputPath),
    `speech-leveler-${randomUUID()}.wav`
  );

  try {
    await applySpeechLevelerPreMaster({
      inputPath,
      outputPath: preMasterPath
    });

    if (debugArtifactDirectoryPath) {
      await persistAudioDebugArtifact({
        sourcePath: preMasterPath,
        directoryPath: debugArtifactDirectoryPath,
        filename: "premaster-output.wav",
        note: "Speech-leveler pre-master output."
      });
    }

    const preMasterMetrics = await measureAudioFileWithWarning(
      preMasterPath,
      "pre-master verification"
    );

    await applySpeechLevelerPass({
      inputPath: preMasterPath,
      outputPath: speechLeveledPath
    });

    if (debugArtifactDirectoryPath) {
      const speechLevelerDebugPath = path.join(
        path.dirname(outputPath),
        `speech-leveler-debug-${randomUUID()}.mp3`
      );

      try {
        await transcodeAudioFile({
          inputPath: speechLeveledPath,
          outputPath: speechLevelerDebugPath,
          outputFormat: "mp3",
          applyLoudnorm: false,
          stage: "encoding"
        });

        await persistAudioDebugArtifact({
          sourcePath: speechLevelerDebugPath,
          directoryPath: debugArtifactDirectoryPath,
          filename: "speechnorm-test-output.mp3",
          note: "Speech-leveler intermediate before final static gain targeting."
        });
      } finally {
        await rm(speechLevelerDebugPath, { force: true });
      }
    }

    const measurement = await measureForLinearMastering(speechLeveledPath, settings);
    const speechLevelerResult = await applyStaticGainMaster({
      inputPath: speechLeveledPath,
      outputPath,
      outputFormat,
      settings,
      measurement
    });
    const metrics = await measureAudioFileWithWarning(outputPath, "post-master verification");

    if (debugArtifactDirectoryPath) {
      await persistAudioDebugArtifact({
        sourcePath: outputPath,
        directoryPath: debugArtifactDirectoryPath,
        filename: `final-master-output.${getFileExtension(outputFormat)}`,
        note: "Speech-leveler final delivery."
      });
    }

    logMasteringSummary({
      volumeBoost,
      strategy: "speech-leveler",
      executionMode: "speech-leveler",
      appliedGainDb: speechLevelerResult.appliedGainDb,
      settings,
      preMasterMetrics,
      metrics
    });

    return {
      metrics,
      preMasterMetrics,
      strategy: "speech-leveler",
      executionMode: "speech-leveler",
      appliedGainDb: speechLevelerResult.appliedGainDb
    };
  } finally {
    await rm(preMasterPath, { force: true });
    await rm(speechLeveledPath, { force: true });
  }
}

async function applySpeechPreMaster({
  inputPath,
  outputPath
}: {
  inputPath: string;
  outputPath: string;
}): Promise<void> {
  await applyWavFilterPass({
    inputPath,
    outputPath,
    filter: SPEECH_PREMASTER_FILTER
  });
}

async function applySpeechLevelerPreMaster({
  inputPath,
  outputPath
}: {
  inputPath: string;
  outputPath: string;
}): Promise<void> {
  await applyWavFilterPass({
    inputPath,
    outputPath,
    filter: SPEECH_LEVELER_PREMASTER_FILTER
  });
}

async function applySpeechLevelerPass({
  inputPath,
  outputPath
}: {
  inputPath: string;
  outputPath: string;
}): Promise<void> {
  await applyWavFilterPass({
    inputPath,
    outputPath,
    filter: SPEECH_LEVELER_FILTER
  });
}

async function applyWavFilterPass({
  inputPath,
  outputPath,
  filter
}: {
  inputPath: string;
  outputPath: string;
  filter: string;
}): Promise<void> {
  await runFfmpeg(
    [
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-af",
      filter,
      "-ar",
      String(PREMASTER_INTERMEDIATE_SAMPLE_RATE),
      "-ac",
      String(PREMASTER_INTERMEDIATE_CHANNELS),
      "-c:a",
      "pcm_s16le",
      outputPath
    ],
    { stage: "premaster" }
  );

  await assertAudioFileReady(outputPath);
}

async function applyStaticGainMaster({
  inputPath,
  outputPath,
  outputFormat,
  settings,
  measurement
}: {
  inputPath: string;
  outputPath: string;
  outputFormat: OutputFormat;
  settings: LoudnessSettings;
  measurement: LoudnormMeasurement;
}): Promise<{ appliedGainDb: number }> {
  const filter = buildStaticGainMasteringFilter(settings, measurement);
  const appliedGainDb = computeStaticMasteringGainDb(settings, measurement);

  await runFfmpeg(
    [
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-af",
      filter,
      ...getCodecArgs(outputFormat),
      outputPath
    ],
    { stage: "final-normalization" }
  );

  await assertAudioFileReady(outputPath);

  return { appliedGainDb };
}

async function copyOrEncodeAudioWithoutMastering({
  inputPath,
  outputPath,
  outputFormat
}: {
  inputPath: string;
  outputPath: string;
  outputFormat: OutputFormat;
}): Promise<void> {
  const inputExtension = path.extname(inputPath).replace(/^\./, "").toLowerCase();

  if (inputExtension === outputFormat) {
    await copyFile(inputPath, outputPath);
    await assertAudioFileReady(outputPath);
    return;
  }

  await transcodeAudioFile({
    inputPath,
    outputPath,
    outputFormat,
    applyLoudnorm: false,
    stage: "encoding"
  });
}

async function measureAudioFileWithWarning(
  filePath: string,
  warningLabel: string
): Promise<AudioLoudnessMetrics | null> {
  return await measureAudioFile(filePath).catch((error) => {
    console.warn(
      `[mastering] ${warningLabel} unavailable`,
      JSON.stringify({
        filePath,
        reason: error instanceof Error ? error.message : "Unknown measurement failure."
      })
    );
    return null;
  });
}

function logMasteringSummary({
  volumeBoost,
  strategy,
  executionMode,
  appliedGainDb,
  settings,
  preMasterMetrics,
  metrics
}: {
  volumeBoost: VolumeBoost;
  strategy: MasteringStrategy;
  executionMode: MasteringExecutionMode;
  appliedGainDb: number | null;
  settings: LoudnessSettings;
  preMasterMetrics: AudioLoudnessMetrics | null;
  metrics: AudioLoudnessMetrics | null;
}): void {
  console.info(
    "[mastering] final",
    JSON.stringify({
      volumeBoost,
      strategy,
      executionMode,
      appliedGainDb,
      targetIntegratedLoudness: settings.integratedLoudness,
      targetTruePeak: settings.truePeak,
      preMasterIntegratedLoudness: preMasterMetrics?.integratedLoudness ?? null,
      preMasterTruePeak: preMasterMetrics?.truePeak ?? null,
      measuredIntegratedLoudness: metrics?.integratedLoudness ?? null,
      measuredTruePeak: metrics?.truePeak ?? null
    })
  );
}

export function buildStaticGainMasteringFilter(
  settings: LoudnessSettings,
  measurement: LoudnormMeasurement
): string {
  const gainDb = computeStaticMasteringGainDb(settings, measurement);
  const filters: string[] = [];

  if (Math.abs(gainDb) >= 0.05) {
    filters.push(`volume=${gainDb.toFixed(2)}dB`);
  }

  filters.push(`alimiter=limit=${settings.limiter}:level=disabled`);
  return filters.join(",");
}

export function computeStaticMasteringGainDb(
  settings: LoudnessSettings,
  measurement: LoudnormMeasurement
): number {
  const measuredI = Number(measurement.input_i);
  const measuredTP = Number(measurement.input_tp);

  if (!Number.isFinite(measuredI) || !Number.isFinite(measuredTP)) {
    return 0;
  }

  const requiredGainDb = settings.integratedLoudness - measuredI;
  const peakHeadroomDb = settings.truePeak - measuredTP;
  return Math.min(requiredGainDb, peakHeadroomDb);
}

export function canLinearLoudnormEngage(
  measurement: LoudnormMeasurement,
  settings: LoudnessSettings
): boolean {
  const measuredI = Number(measurement.input_i);
  const measuredTP = Number(measurement.input_tp);

  if (!Number.isFinite(measuredI) || !Number.isFinite(measuredTP)) {
    return false;
  }

  const requiredGainDb = settings.integratedLoudness - measuredI;
  const peakHeadroomDb = settings.truePeak - measuredTP;
  return requiredGainDb <= peakHeadroomDb - LINEAR_LOUDNORM_HEADROOM_DB;
}

async function measureForLinearMastering(
  inputPath: string,
  settings: LoudnessSettings
): Promise<LoudnormMeasurement> {
  const { stderr } = await runFfmpegAndCapture(
    [
      "-hide_banner",
      "-nostats",
      "-i",
      inputPath,
      "-vn",
      "-af",
      `loudnorm=I=${settings.integratedLoudness}:TP=${settings.truePeak}:LRA=11:print_format=json`,
      "-f",
      "null",
      "-"
    ],
    { stage: "measurement" }
  );

  const measurement = toLoudnormMeasurement(parseLoudnormStats(stderr));

  if (!measurement) {
    throw new Error(
      "Loudness measurement pass did not return usable statistics (input_i/input_tp/input_lra/input_thresh/target_offset)."
    );
  }

  return measurement;
}

export function buildLinearMasteringFilter(
  settings: LoudnessSettings,
  measurement: LoudnormMeasurement
): string {
  const loudnorm = [
    `loudnorm=I=${settings.integratedLoudness}`,
    `TP=${settings.truePeak}`,
    `LRA=11`,
    `measured_I=${measurement.input_i}`,
    `measured_TP=${measurement.input_tp}`,
    `measured_LRA=${measurement.input_lra}`,
    `measured_thresh=${measurement.input_thresh}`,
    `offset=${measurement.target_offset}`,
    `linear=true`,
    `print_format=json`
  ].join(":");

  return `${loudnorm},alimiter=limit=${settings.limiter}:level=disabled`;
}

export async function measureAudioFile(inputPath: string): Promise<AudioLoudnessMetrics> {
  await assertAudioFileReady(inputPath);

  const loudnormOutput = await runFfmpegAndCapture(
    ["-hide_banner", "-nostats", "-i", inputPath, "-vn", "-af", LOUDNESS_MEASUREMENT_FILTER, "-f", "null", "-"],
    { stage: "measurement" }
  );
  const loudnormMetrics = parseLoudnormMetrics(loudnormOutput.stderr);

  if (loudnormMetrics) {
    return loudnormMetrics;
  }

  const maxVolumeOutput = await runFfmpegAndCapture(
    ["-hide_banner", "-nostats", "-i", inputPath, "-vn", "-af", "volumedetect", "-f", "null", "-"],
    { stage: "measurement" }
  );
  const maxVolume = parseMaxVolume(maxVolumeOutput.stderr);

  if (maxVolume !== null) {
    return {
      integratedLoudness: null,
      truePeak: null,
      maxVolume,
      measurementMode: "volumedetect"
    };
  }

  throw new Error(`Unable to measure loudness for ${path.basename(inputPath)}.`);
}

export async function measureSegmentAudioFile(inputPath: string): Promise<SegmentAudioMetrics> {
  await assertAudioFileReady(inputPath);

  const timeline = await analyzeAudioFileOverTime(inputPath).catch((error) => {
    console.warn(
      "[segment-metrics] ebur128 analysis unavailable",
      JSON.stringify({
        filePath: inputPath,
        reason: error instanceof Error ? error.message : "Unknown segment analysis failure."
      })
    );
    return null;
  });
  const hasEbur128Loudness =
    timeline?.integratedLoudness !== null &&
    timeline?.integratedLoudness !== undefined &&
    timeline?.truePeak !== null &&
    timeline?.truePeak !== undefined;
  const fallbackMetrics =
    hasEbur128Loudness
      ? null
      : await measureAudioFile(inputPath).catch((error) => {
          console.warn(
            "[segment-metrics] loudnorm fallback unavailable",
            JSON.stringify({
              filePath: inputPath,
              reason: error instanceof Error ? error.message : "Unknown segment measurement failure."
            })
          );
          return null;
        });
  const maxVolume = await measureMaxVolume(inputPath).catch((error) => {
    console.warn(
      "[segment-metrics] max volume unavailable",
      JSON.stringify({
        filePath: inputPath,
        reason: error instanceof Error ? error.message : "Unknown max-volume measurement failure."
      })
    );
    return null;
  });
  const shortTermByTimestamp = timeline?.shortTermByTimestamp ?? [];
  const firstWindowLoudness = shortTermByTimestamp[0]?.shortTermLufs ?? null;
  const lastWindowLoudness = shortTermByTimestamp.at(-1)?.shortTermLufs ?? null;
  const largestInternalJump = timeline?.largestJumps[0] ?? null;
  const internalDriftLufs =
    firstWindowLoudness === null || lastWindowLoudness === null
      ? null
      : roundToTwoDecimals(Math.abs(lastWindowLoudness - firstWindowLoudness));

  return {
    durationSeconds: timeline?.durationSeconds ?? null,
    integratedLoudness: timeline?.integratedLoudness ?? fallbackMetrics?.integratedLoudness ?? null,
    truePeak: timeline?.truePeak ?? fallbackMetrics?.truePeak ?? null,
    maxVolume: maxVolume ?? fallbackMetrics?.maxVolume ?? null,
    loudnessRange: timeline?.loudnessRange ?? null,
    shortTermByTimestamp,
    firstWindowLoudness,
    lastWindowLoudness,
    largestInternalJump,
    internalDriftLufs
  };
}

export async function analyzeAudioFileOverTime(
  inputPath: string,
  {
    bucketSeconds = 1,
    topJumpCount = 8
  }: {
    bucketSeconds?: number;
    topJumpCount?: number;
  } = {}
): Promise<AudioLoudnessTimeline> {
  await assertAudioFileReady(inputPath);

  const ffmpegExecutable = await getFfmpegExecutable();
  const argumentsList = [
    "-hide_banner",
    "-loglevel",
    "verbose",
    "-nostats",
    "-i",
    inputPath,
    "-vn",
    "-filter_complex",
    EBUR128_ANALYSIS_FILTER,
    "-f",
    "null",
    "-"
  ];
  const startTime = Date.now();

  console.info(
    "[ffmpeg] starting",
    JSON.stringify({
      stage: "measurement",
      executable: ffmpegExecutable,
      args: argumentsList
    })
  );

  const result = spawnSync(ffmpegExecutable, argumentsList, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024
  });
  const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  if (result.error) {
    const spawnError = result.error as NodeJS.ErrnoException;
    throw spawnError.code === "ENOENT"
      ? new Error(FFMPEG_MISSING_MESSAGE)
      : new Error(`ffmpeg could not start during audio measurement: ${spawnError.message}`);
  }

  if (result.status !== 0 || result.signal) {
    const failure = new AudioProcessingError({
      stage: "measurement",
      executable: ffmpegExecutable,
      args: argumentsList,
      stderr: combinedOutput,
      exitCode: result.status,
      signal: result.signal as NodeJS.Signals | null,
      timedOut: result.signal === "SIGKILL"
    });

    console.error(
      "[ffmpeg] failed",
      JSON.stringify({
        stage: "measurement",
        durationMs: Date.now() - startTime,
        executable: ffmpegExecutable,
        args: argumentsList,
        exitCode: result.status,
        signal: result.signal,
        timedOut: result.signal === "SIGKILL",
        stderrSummary: failure.stderrSummary
      })
    );

    throw failure;
  }

  console.info(
    "[ffmpeg] completed",
    JSON.stringify({
      stage: "measurement",
      durationMs: Date.now() - startTime
    })
  );

  return parseEbur128Analysis(combinedOutput, {
    bucketSeconds,
    topJumpCount
  });
}

export function parseEbur128Analysis(
  output: string,
  {
    bucketSeconds = 1,
    topJumpCount = 8
  }: {
    bucketSeconds?: number;
    topJumpCount?: number;
  } = {}
): AudioLoudnessTimeline {
  const framePattern =
    /t:\s*(?<seconds>-?(?:\d+(?:\.\d+)?|\.\d+))\s+TARGET:[^\n]*?\bM:\s*(?<momentary>-?(?:\d+(?:\.\d+)?|inf)|nan)\s+S:\s*(?<shortTerm>-?(?:\d+(?:\.\d+)?|inf)|nan)\s+I:\s*(?<integrated>-?(?:\d+(?:\.\d+)?|inf)|nan)\s+LUFS\s+LRA:\s*(?<range>-?(?:\d+(?:\.\d+)?|inf)|nan)\s+LU/gi;
  const samples: AudioLoudnessTimelinePoint[] = [];

  for (const match of output.matchAll(framePattern)) {
    const seconds = parseNullableFiniteNumber(match.groups?.seconds);
    const shortTermLufs = parseNullableFiniteNumber(match.groups?.shortTerm);

    if (seconds === null || shortTermLufs === null || shortTermLufs <= MIN_VALID_SHORT_TERM_LUFS) {
      continue;
    }

    samples.push({
      seconds,
      shortTermLufs
    });
  }

  const shortTermByTimestamp = bucketShortTermSamples(samples, bucketSeconds);

  return {
    durationSeconds: parseDurationSeconds(output),
    integratedLoudness: parseSummaryMetric(
      output,
      /Summary:[\s\S]*?Integrated loudness:\s+I:\s*(-?(?:\d+(?:\.\d+)?|inf))\s+LUFS/i
    ),
    truePeak: parseSummaryMetric(
      output,
      /Summary:[\s\S]*?True peak:\s+Peak:\s*(-?(?:\d+(?:\.\d+)?|inf))\s+dBFS/i
    ),
    loudnessRange: parseSummaryMetric(
      output,
      /Summary:[\s\S]*?Loudness range:\s+LRA:\s*(-?(?:\d+(?:\.\d+)?|inf))\s+LU/i
    ),
    shortTermByTimestamp,
    largestJumps: findLargestShortTermJumps(shortTermByTimestamp, topJumpCount)
  };
}

export function formatAudioTimestamp(seconds: number): string {
  const roundedSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(roundedSeconds / 3600);
  const minutes = Math.floor((roundedSeconds % 3600) / 60);
  const remainingSeconds = roundedSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
      remainingSeconds
    ).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

export function buildSegmentStandardizationArgs({
  inputPath,
  outputPath
}: {
  inputPath: string;
  outputPath: string;
}): string[] {
  return [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-af",
    SEGMENT_STANDARDIZATION_FILTER,
    "-ac",
    String(STANDARD_INTERMEDIATE_CHANNELS),
    "-ar",
    String(STANDARD_INTERMEDIATE_SAMPLE_RATE),
    "-c:a",
    "pcm_s16le",
    outputPath
  ];
}

export function buildSegmentLevelingArgs({
  inputPath,
  outputPath,
  filter
}: {
  inputPath: string;
  outputPath: string;
  filter: string;
}): string[] {
  return [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-af",
    filter,
    "-ac",
    String(STANDARD_INTERMEDIATE_CHANNELS),
    "-ar",
    String(STANDARD_INTERMEDIATE_SAMPLE_RATE),
    "-c:a",
    "pcm_s16le",
    outputPath
  ];
}

export function buildSegmentLevelingFilter(
  settings: SegmentLevelingSettings,
  gainDb: number,
  driftCorrectionDb = 0,
  durationSeconds: number | null = null
): string {
  const filters: string[] = [];

  if (Math.abs(gainDb) >= 0.05) {
    filters.push(`volume=${gainDb.toFixed(2)}dB`);
  }

  if (
    driftCorrectionDb >= 0.05 &&
    durationSeconds !== null &&
    Number.isFinite(durationSeconds) &&
    durationSeconds > 0
  ) {
    const safeDurationSeconds = Math.max(0.1, durationSeconds);
    filters.push(
      `volume='if(isnan(t)\\,1\\,exp(log(10)*(${driftCorrectionDb.toFixed(
        2
      )}*t/${safeDurationSeconds.toFixed(2)})/20))':eval=frame`
    );
  }

  filters.push(`alimiter=limit=${settings.limiter}:level=disabled`);
  return filters.join(",");
}

export function computeSegmentLevelingGainDb(
  settings: SegmentLevelingSettings,
  metrics: Pick<SegmentAudioMetrics, "integratedLoudness" | "truePeak">
): number {
  const measuredLoudness = metrics.integratedLoudness;
  const measuredTruePeak = metrics.truePeak;

  if (
    measuredLoudness === null ||
    measuredTruePeak === null ||
    !Number.isFinite(measuredLoudness) ||
    !Number.isFinite(measuredTruePeak)
  ) {
    return 0;
  }

  const requiredGainDb = settings.integratedLoudness - measuredLoudness;
  const boundedByGainRange =
    requiredGainDb >= 0
      ? Math.min(requiredGainDb, settings.maxBoostDb)
      : Math.max(requiredGainDb, -settings.maxCutDb);

  if (boundedByGainRange <= 0) {
    return roundToTwoDecimals(boundedByGainRange);
  }

  const peakHeadroomDb = settings.truePeak - measuredTruePeak;
  return roundToTwoDecimals(Math.max(0, Math.min(boundedByGainRange, peakHeadroomDb)));
}

export function computeSegmentDriftCorrectionDb(
  settings: SegmentLevelingSettings,
  metrics: Pick<SegmentAudioMetrics, "firstWindowLoudness" | "lastWindowLoudness">
): number {
  const firstWindowLoudness = metrics.firstWindowLoudness;
  const lastWindowLoudness = metrics.lastWindowLoudness;

  if (
    firstWindowLoudness === null ||
    lastWindowLoudness === null ||
    !Number.isFinite(firstWindowLoudness) ||
    !Number.isFinite(lastWindowLoudness)
  ) {
    return 0;
  }

  const fadeDownDb = firstWindowLoudness - lastWindowLoudness;

  if (fadeDownDb <= settings.driftCorrectionThresholdLufs) {
    return 0;
  }

  return roundToTwoDecimals(Math.min(fadeDownDb, settings.maxDriftCorrectionDb));
}

export function buildSegmentBoundaryDiagnostics(
  segmentMetrics: SegmentAudioMetrics[],
  pauseDurationSeconds = 0,
  boundaryThresholdLufs = SEGMENT_BOUNDARY_DELTA_WARNING_LU,
  nearBoundaryThresholdLufs = SEGMENT_NEAR_BOUNDARY_JUMP_WARNING_LU
): SegmentBoundaryDiagnostic[] {
  const diagnostics: SegmentBoundaryDiagnostic[] = [];
  let segmentStartSeconds: number | null = 0;

  for (let index = 0; index < segmentMetrics.length - 1; index += 1) {
    const current = segmentMetrics[index];
    const next = segmentMetrics[index + 1];
    const boundaryTimestampSeconds: number | null =
      segmentStartSeconds === null || current.durationSeconds === null
        ? null
        : roundToTwoDecimals(segmentStartSeconds + current.durationSeconds);
    const nextSpeechTimestampSeconds: number | null =
      boundaryTimestampSeconds === null
        ? null
        : roundToTwoDecimals(boundaryTimestampSeconds + pauseDurationSeconds);
    const deltaLufs =
      current.lastWindowLoudness === null || next.firstWindowLoudness === null
        ? null
        : roundToTwoDecimals(Math.abs(next.firstWindowLoudness - current.lastWindowLoudness));

    diagnostics.push({
      boundaryIndex: index + 1,
      previousSegmentIndex: index + 1,
      nextSegmentIndex: index + 2,
      boundaryTimestampSeconds,
      nextSpeechTimestampSeconds,
      beforeLoudness: current.lastWindowLoudness,
      afterLoudness: next.firstWindowLoudness,
      deltaLufs,
      exceedsThreshold: deltaLufs !== null && deltaLufs > boundaryThresholdLufs,
      nearBoundaryJumpLufs: deltaLufs,
      nearBoundaryJumpExceedsThreshold:
        deltaLufs !== null && deltaLufs > nearBoundaryThresholdLufs
    });

    segmentStartSeconds =
      nextSpeechTimestampSeconds === null ? null : nextSpeechTimestampSeconds;
  }

  return diagnostics;
}

export function collectSegmentDiagnosticsWarnings({
  boundaries,
  segmentMetrics,
  finalMetrics,
  finalTruePeakTarget
}: {
  boundaries: SegmentBoundaryDiagnostic[];
  segmentMetrics: SegmentAudioMetrics[];
  finalMetrics: AudioLoudnessMetrics | null;
  finalTruePeakTarget: number;
}): SegmentDiagnosticsWarning[] {
  const warnings: SegmentDiagnosticsWarning[] = [];

  for (const boundary of boundaries) {
    if (boundary.deltaLufs !== null && boundary.deltaLufs > SEGMENT_BOUNDARY_DELTA_WARNING_LU) {
      warnings.push({
        code: "boundary-delta",
        message: `Boundary ${boundary.boundaryIndex} loudness delta is ${boundary.deltaLufs.toFixed(
          2
        )} LU.`,
        boundaryIndex: boundary.boundaryIndex,
        value: boundary.deltaLufs,
        threshold: SEGMENT_BOUNDARY_DELTA_WARNING_LU
      });
    }

    if (
      boundary.nearBoundaryJumpLufs !== null &&
      boundary.nearBoundaryJumpLufs > SEGMENT_NEAR_BOUNDARY_JUMP_WARNING_LU
    ) {
      warnings.push({
        code: "near-boundary-jump",
        message: `Boundary ${boundary.boundaryIndex} near-boundary jump is ${boundary.nearBoundaryJumpLufs.toFixed(
          2
        )} LU.`,
        boundaryIndex: boundary.boundaryIndex,
        value: boundary.nearBoundaryJumpLufs,
        threshold: SEGMENT_NEAR_BOUNDARY_JUMP_WARNING_LU
      });
    }
  }

  for (const [index, metrics] of segmentMetrics.entries()) {
    if (metrics.internalDriftLufs !== null && metrics.internalDriftLufs > SEGMENT_INTERNAL_DRIFT_WARNING_LU) {
      warnings.push({
        code: "segment-internal-drift",
        message: `Segment ${index + 1} internal drift is ${metrics.internalDriftLufs.toFixed(
          2
        )} LU.`,
        segmentIndex: index + 1,
        value: metrics.internalDriftLufs,
        threshold: SEGMENT_INTERNAL_DRIFT_WARNING_LU
      });
    }
  }

  if (!finalMetrics || finalMetrics.truePeak === null) {
    warnings.push({
      code: "final-metrics-missing",
      message: "Final true-peak metrics are missing."
    });
  } else if (finalMetrics.truePeak > finalTruePeakTarget + 0.1) {
    warnings.push({
      code: "final-true-peak",
      message: `Final true peak is ${finalMetrics.truePeak.toFixed(2)} dBFS.`,
      value: finalMetrics.truePeak,
      threshold: finalTruePeakTarget
    });
  }

  return warnings;
}

export function buildTranscodeArgs({
  inputPath,
  outputPath,
  outputFormat,
  applyLoudnorm,
  volumeBoost = DEFAULT_VOLUME_BOOST,
  masteringCorrectionDb = 0,
  trimSilence = false,
  sampleRate,
  channels
}: {
  inputPath: string;
  outputPath: string;
  outputFormat: OutputFormat;
  applyLoudnorm: boolean;
  volumeBoost?: VolumeBoost;
  masteringCorrectionDb?: number;
  trimSilence?: boolean;
  sampleRate?: number;
  channels?: number;
}): string[] {
  const args = ["-y", "-i", inputPath, "-vn"];
  const audioFilterChain = buildAudioFilterChain({
    applyLoudnorm,
    volumeBoost,
    masteringCorrectionDb,
    trimSilence
  });

  if (audioFilterChain) {
    args.push("-af", audioFilterChain);
  }

  if (channels) {
    args.push("-ac", String(channels));
  }

  if (sampleRate) {
    args.push("-ar", String(sampleRate));
  }

  return [...args, ...getCodecArgs(outputFormat), outputPath];
}

export function buildMergeArgs({
  listFilePath,
  outputPath,
  outputFormat,
  strategy
}: {
  listFilePath: string;
  outputPath: string;
  outputFormat: OutputFormat;
  strategy: MergeStrategy;
}): string[] {
  return [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFilePath,
    "-vn",
    ...(strategy === "copy" ? ["-c", "copy"] : getCodecArgs(outputFormat)),
    outputPath
  ];
}

export function buildMasteringFilter(
  volumeBoost: VolumeBoost,
  masteringCorrectionDb = 0
): string {
  const settings = VOLUME_BOOST_SETTINGS[volumeBoost];
  const filters = [`loudnorm=I=${settings.integratedLoudness}:TP=${settings.truePeak}:LRA=11`];

  if (Math.abs(masteringCorrectionDb) >= 0.05) {
    filters.push(`volume=${Number(masteringCorrectionDb.toFixed(2))}dB`);
  }

  filters.push(`alimiter=limit=${settings.limiter}:level=disabled`);
  return filters.join(",");
}

export function summarizeFfmpegStderr(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !FFMPEG_BANNER_LINE_PATTERNS.some((pattern) => pattern.test(line)) &&
        !FFMPEG_PROGRESS_LINE_PATTERNS.some((pattern) => pattern.test(line))
    );

  if (lines.length === 0) {
    return "";
  }

  const interestingLines = lines.filter((line) => FFMPEG_INTERESTING_LINE_PATTERN.test(line));
  const selectedLines = (interestingLines.length > 0 ? interestingLines : lines).slice(-4);

  return truncate(selectedLines.join(" | "), 400);
}

async function runFfmpeg(
  argumentsList: string[],
  { stage }: { stage: AudioProcessingStage }
): Promise<void> {
  await runFfmpegAndCapture(argumentsList, { stage });
}

async function runFfmpegAndCapture(
  argumentsList: string[],
  { stage }: { stage: AudioProcessingStage }
): Promise<{
  stdout: string;
  stderr: string;
}> {
  const ffmpegExecutable = await getFfmpegExecutable();
  const startTime = Date.now();

  console.info(
    "[ffmpeg] starting",
    JSON.stringify({
      stage,
      executable: ffmpegExecutable,
      args: argumentsList
    })
  );

  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const ffmpegProcess = spawn(ffmpegExecutable, argumentsList, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      ffmpegProcess.kill("SIGKILL");
    }, FFMPEG_TIMEOUT_MS);

    ffmpegProcess.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    ffmpegProcess.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    ffmpegProcess.once("error", (error) => {
      clearTimeout(timeoutHandle);
      const spawnError = error as NodeJS.ErrnoException;

      reject(
        spawnError.code === "ENOENT"
          ? new Error(FFMPEG_MISSING_MESSAGE)
          : new Error(
              `ffmpeg could not start during ${AUDIO_STAGE_LABELS[stage]}: ${spawnError.message}`
            )
      );
    });

    ffmpegProcess.once("exit", (code, signal) => {
      clearTimeout(timeoutHandle);

      if (code === 0 && !timedOut) {
        console.info(
          "[ffmpeg] completed",
          JSON.stringify({
            stage,
            durationMs: Date.now() - startTime
          })
        );
        resolve({ stdout, stderr });
        return;
      }

      const failure = new AudioProcessingError({
        stage,
        executable: ffmpegExecutable,
        args: argumentsList,
        stderr,
        exitCode: code,
        signal,
        timedOut
      });

      console.error(
        "[ffmpeg] failed",
        JSON.stringify({
          stage,
          durationMs: Date.now() - startTime,
          executable: ffmpegExecutable,
          args: argumentsList,
          exitCode: code,
          signal,
          timedOut,
          stderrSummary: failure.stderrSummary
        })
      );

      reject(failure);
    });
  });
}

async function getFfmpegExecutable(): Promise<string> {
  if (!ffmpegExecutablePromise) {
    ffmpegExecutablePromise = resolveFfmpegExecutable();
  }

  return ffmpegExecutablePromise;
}

async function resolveFfmpegExecutable(): Promise<string> {
  for (const candidate of FFMPEG_CANDIDATES) {
    if (await canStartFfmpeg(candidate)) {
      return candidate;
    }
  }

  throw new Error(FFMPEG_MISSING_MESSAGE);
}

async function canStartFfmpeg(executable: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const process = spawn(executable, ["-version"], {
      stdio: ["ignore", "ignore", "ignore"]
    });

    process.once("error", () => {
      resolve(false);
    });

    process.once("exit", (code) => {
      resolve(code === 0);
    });
  });
}

async function assertAudioFileReady(filePath: string): Promise<void> {
  const fileStats = await stat(filePath);

  if (!fileStats.isFile()) {
    throw new Error(`Audio file is missing: ${path.basename(filePath)}`);
  }

  if (fileStats.size === 0) {
    throw new Error(`Audio file is empty: ${path.basename(filePath)}`);
  }

  const handle = await open(filePath, "r");

  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);

    if (filePath.endsWith(".wav")) {
      const isWave =
        bytesRead >= 12 &&
        header.subarray(0, 4).toString("ascii") === "RIFF" &&
        header.subarray(8, 12).toString("ascii") === "WAVE";

      if (!isWave) {
        throw new Error(`Audio file is not a valid WAV: ${path.basename(filePath)}`);
      }
    }

    if (filePath.endsWith(".mp3")) {
      const startsWithId3 = bytesRead >= 3 && header.subarray(0, 3).toString("ascii") === "ID3";
      const startsWithFrameSync =
        bytesRead >= 2 && header[0] === 0xff && (header[1] & 0xe0) === 0xe0;

      if (!startsWithId3 && !startsWithFrameSync) {
        throw new Error(`Audio file is not a valid MP3: ${path.basename(filePath)}`);
      }
    }
  } finally {
    await handle.close();
  }
}

function buildAudioFilterChain({
  applyLoudnorm,
  volumeBoost,
  masteringCorrectionDb,
  trimSilence
}: {
  applyLoudnorm: boolean;
  volumeBoost: VolumeBoost;
  masteringCorrectionDb: number;
  trimSilence: boolean;
}): string | null {
  const filters: string[] = [];

  if (trimSilence) {
    filters.push(TRIM_SILENCE_FILTER);
  }

  if (applyLoudnorm) {
    filters.push(buildMasteringFilter(volumeBoost, masteringCorrectionDb));
  }

  if (filters.length === 0) {
    return null;
  }

  return filters.join(",");
}

function buildSilenceArgs({
  outputPath,
  durationMs,
  sampleRate,
  channels
}: {
  outputPath: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
}): string[] {
  const channelLayout = channels === 1 ? "mono" : channels === 2 ? "stereo" : `${channels}c`;

  return [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=${sampleRate}:cl=${channelLayout}`,
    "-t",
    (durationMs / 1000).toFixed(3),
    "-c:a",
    "pcm_s16le",
    outputPath
  ];
}

function getCodecArgs(outputFormat: OutputFormat): string[] {
  if (outputFormat === "wav") {
    return ["-c:a", "pcm_s16le"];
  }

  return ["-c:a", "libmp3lame", "-b:a", MP3_BITRATE];
}

function escapeForFfmpegConcat(filePath: string): string {
  return filePath.replace(/'/g, "'\\''");
}

function getLimiterLimit(truePeak: number): number {
  return Number((10 ** (truePeak / 20)).toFixed(3));
}

function parseLoudnormStats(output: string): LoudnormStats | null {
  const match = output.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);

  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[0]) as LoudnormStats;
  } catch {
    return null;
  }
}

function toLoudnormMeasurement(stats: LoudnormStats | null): LoudnormMeasurement | null {
  if (!stats) {
    return null;
  }

  const { input_i, input_tp, input_lra, input_thresh, target_offset } = stats;

  if (
    !isFiniteNumericString(input_i) ||
    !isFiniteNumericString(input_tp) ||
    !isFiniteNumericString(input_lra) ||
    !isFiniteNumericString(input_thresh) ||
    !isFiniteNumericString(target_offset)
  ) {
    return null;
  }

  return { input_i, input_tp, input_lra, input_thresh, target_offset };
}

function isFiniteNumericString(value: string | undefined): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed);
}

function parseLoudnormMetrics(output: string): AudioLoudnessMetrics | null {
  const stats = parseLoudnormStats(output);

  if (!stats) {
    return null;
  }

  return {
    integratedLoudness: parseFiniteNumber(stats.input_i),
    truePeak: parseFiniteNumber(stats.input_tp),
    maxVolume: null,
    measurementMode: "loudnorm"
  };
}

function parseMaxVolume(output: string): number | null {
  const match = output.match(/max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i);
  return parseFiniteNumber(match?.[1]);
}

async function measureMaxVolume(inputPath: string): Promise<number | null> {
  const { stderr } = await runFfmpegAndCapture(
    ["-hide_banner", "-nostats", "-i", inputPath, "-vn", "-af", "volumedetect", "-f", "null", "-"],
    { stage: "measurement" }
  );

  return parseMaxVolume(stderr);
}

function parseDurationSeconds(output: string): number | null {
  const match = output.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/i);

  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }

  return roundToTwoDecimals(hours * 3600 + minutes * 60 + seconds);
}

function parseSummaryMetric(output: string, pattern: RegExp): number | null {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matches = [...output.matchAll(new RegExp(pattern.source, flags))];
  const lastMatch = matches.at(-1);
  return parseNullableFiniteNumber(lastMatch?.[1]);
}

function parseFiniteNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNullableFiniteNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "nan" || normalized === "inf" || normalized === "-inf") {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundToTwoDecimals(value: number): number {
  return Number(value.toFixed(2));
}

function bucketShortTermSamples(
  samples: AudioLoudnessTimelinePoint[],
  bucketSeconds: number
): AudioLoudnessTimelinePoint[] {
  const safeBucketSeconds = Number.isFinite(bucketSeconds) && bucketSeconds > 0 ? bucketSeconds : 1;
  const buckets = new Map<number, AudioLoudnessTimelinePoint>();

  for (const sample of samples) {
    const bucketIndex = Math.floor(sample.seconds / safeBucketSeconds);
    buckets.set(bucketIndex, {
      seconds: Number((bucketIndex * safeBucketSeconds).toFixed(2)),
      shortTermLufs: Number(sample.shortTermLufs.toFixed(2))
    });
  }

  return [...buckets.entries()]
    .sort(([leftBucket], [rightBucket]) => leftBucket - rightBucket)
    .map(([, sample]) => sample);
}

function findLargestShortTermJumps(
  samples: AudioLoudnessTimelinePoint[],
  topJumpCount: number
): AudioLoudnessJump[] {
  const jumps: AudioLoudnessJump[] = [];

  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const deltaLufs = Math.abs(current.shortTermLufs - previous.shortTermLufs);

    jumps.push({
      fromSeconds: previous.seconds,
      toSeconds: current.seconds,
      fromShortTermLufs: previous.shortTermLufs,
      toShortTermLufs: current.shortTermLufs,
      deltaLufs: Number(deltaLufs.toFixed(2))
    });
  }

  return jumps
    .sort(
      (left, right) =>
        right.deltaLufs - left.deltaLufs || left.fromSeconds - right.fromSeconds
    )
    .slice(0, Math.max(1, Math.floor(topJumpCount)));
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function truncate(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength)}...`;
}
