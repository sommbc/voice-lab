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

export type AudioWindowStats = {
  rmsLevelDb: number | null;
  peakLevelDb: number | null;
  zeroCrossingsRate: number | null;
};

export type EdgeToneBandMetrics = {
  lowDb: number | null;
  midDb: number | null;
  highDb: number | null;
};

export type EdgeToneDeltaMetrics = {
  lowDeltaDb: number | null;
  midDeltaDb: number | null;
  highDeltaDb: number | null;
  averageDeltaDb: number | null;
  weightedDeltaDb: number | null;
  brightnessExcessDb: number | null;
  presenceExcessDb: number | null;
};

export type AcousticTrimSearchCandidate = {
  trimSeconds: number;
  offsetSeconds: number;
  beforeRmsDb: number | null;
  afterRmsDb: number | null;
  combinedRmsDb: number | null;
  score: number;
  selected: boolean;
};

export type AcousticTrimSearchResult = {
  estimatedTrimSeconds: number;
  selectedTrimSeconds: number;
  searchRadiusSeconds: number;
  candidates: AcousticTrimSearchCandidate[];
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
  firstFiveSecondLoudness: number | null;
  lastFiveSecondLoudness: number | null;
  firstTwoSecondRmsDb: number | null;
  lastTwoSecondRmsDb: number | null;
  firstTwoSecondPeakDb: number | null;
  lastTwoSecondPeakDb: number | null;
  firstTwoSecondZeroCrossingRate: number | null;
  lastTwoSecondZeroCrossingRate: number | null;
  firstTwoSecondEdgeTone: EdgeToneBandMetrics;
  lastTwoSecondEdgeTone: EdgeToneBandMetrics;
  leadingEdgeRmsDb: number | null;
  trailingEdgeRmsDb: number | null;
  leadingSpeechCutoffRisk: boolean;
  trailingSpeechCutoffRisk: boolean;
  largestInternalJump: AudioLoudnessJump | null;
  internalDriftLufs: number | null;
};

export type SegmentLevelingResult = {
  appliedGainDb: number;
  driftCorrectionDb: number;
  filter: string;
};

export type SegmentSeamAdjustment = {
  segmentIndex: number;
  startCutDb: number;
  endCutDb: number;
  entrySmoothingCutDb: number;
  entrySmoothingWindowSeconds: number;
  entrySmoothingBoundaryIndex: number | null;
  entrySmoothingReason: string | null;
  filter: string | null;
};

export type SegmentSeamFailureKind = "passed" | "mechanical" | "tonal" | "mixed";

export type SegmentSeamRegenerationAttempt = {
  attempt: number;
  segmentIndex: number;
  reason: string;
  contextOverlapUsed: boolean;
  contextLikelySpoken: boolean;
  accepted: boolean;
  scoreBefore: number;
  scoreAfter: number;
};

export type SegmentBoundaryRepairRecord = {
  applied: boolean;
  strategy: "merge" | "move-next-first-sentence" | "move-previous-last-sentence" | "none";
  reason: string;
};

export type SegmentBoundaryDiagnostic = {
  boundaryIndex: number;
  previousSegmentIndex: number;
  nextSegmentIndex: number;
  boundaryTimestampSeconds: number | null;
  nextSpeechTimestampSeconds: number | null;
  beforeLoudness: number | null;
  afterLoudness: number | null;
  previousLast5sLoudness: number | null;
  nextFirst5sLoudness: number | null;
  deltaLufs: number | null;
  exceedsThreshold: boolean;
  nearBoundaryJumpLufs: number | null;
  nearBoundaryJumpExceedsThreshold: boolean;
  previousLast2sRmsDb: number | null;
  nextFirst2sRmsDb: number | null;
  rmsDeltaDb: number | null;
  gapDurationMs: number;
  previousTruePeak: number | null;
  nextTruePeak: number | null;
  highTruePeakNearBoundary: boolean;
  speechCutoffRiskBefore: boolean;
  speechCutoffRiskAfter: boolean;
  spectralDifferenceScore: number | null;
  previousEdgeTone: EdgeToneBandMetrics;
  nextEdgeTone: EdgeToneBandMetrics;
  edgeToneDelta: EdgeToneDeltaMetrics;
  edgeToneMismatchScore: number;
  suddenToneMismatch: boolean;
  previousSpeakingRateWps: number | null;
  nextSpeakingRateWps: number | null;
  speakingRateDeltaWps: number | null;
  toneMismatchScore: number;
  seamFailureKind: SegmentSeamFailureKind;
  seamFailureReason: string;
  previousContextTail: string | null;
  nextContextHead: string | null;
  contextOverlapUsed: boolean;
  regenerationAttempts: SegmentSeamRegenerationAttempt[];
  boundaryRepair: SegmentBoundaryRepairRecord | null;
  entrySmoothingApplied: boolean;
  entrySmoothingCutDb: number;
  entrySmoothingReason: string | null;
  seamQualityScore: number;
  seamPassed: boolean;
  seamClipPath: string | null;
};

export type SegmentJoinPlan = {
  boundaryIndex: number;
  previousSegmentIndex: number;
  nextSegmentIndex: number;
  pauseMs: number;
  reason: "soft" | "sentence" | "paragraph" | "section" | "disabled";
};

export type SegmentDiagnosticsWarning = {
  code:
    | "boundary-delta"
    | "near-boundary-jump"
    | "seam-quality"
    | "speech-cutoff-risk"
    | "spectral-mismatch"
    | "tonal-mismatch"
    | "seam-gap"
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
  generationAttempt: number;
  generationInputWordCount: number;
  targetWordCount: number;
  contextOverlapUsed: boolean;
  contextInstructionStrength: "none" | "standard" | "strong";
  previousContext: string;
  nextContext: string;
  contextLikelySpoken: boolean;
  contextFallbackUsed: boolean;
  contextAudioTrimmed: boolean;
  contextAudioTrimSeconds: number | null;
  contextAudioTrimEstimatedSeconds?: number | null;
  contextAudioTrimSearch?: AcousticTrimSearchResult | null;
  regenerationReason?: string;
  rawMetrics: SegmentAudioMetrics;
  standardizedMetrics: SegmentAudioMetrics;
  leveledMetrics: SegmentAudioMetrics;
  appliedGainDb: number;
  driftCorrectionDb: number;
  levelingFilter: string;
  seamStartCutDb?: number;
  seamEndCutDb?: number;
  seamEntrySmoothingCutDb?: number;
  seamEntrySmoothingReason?: string | null;
  seamAdjustmentFilter?: string | null;
};

export type SegmentDiagnosticsManifest = {
  version: 1;
  createdAt: string;
  totalSegments: number;
  smoothJoins: boolean;
  joinPauseMs: number;
  joinPlan: SegmentJoinPlan[];
  segmentLeveling: SegmentLevelingSettings;
  segments: SegmentDiagnosticsManifestSegment[];
  boundaries: SegmentBoundaryDiagnostic[];
  warnings: SegmentDiagnosticsWarning[];
  finalMetrics: AudioLoudnessMetrics | null;
  multiTakeOptimization: MultiTakeOptimizationManifest;
};

export type MultiTakeCandidatePenalty = {
  score: number;
  reasons: string[];
};

export type MultiTakeCandidateInput = {
  segmentIndex: number;
  candidateIndex: number;
  metrics: SegmentAudioMetrics;
  generationAttempt?: number;
  contextOverlapUsed?: boolean;
  contextFallbackUsed?: boolean;
  contextAudioTrimmed?: boolean;
  contextAudioTrimSeconds?: number | null;
  contextAudioTrimEstimatedSeconds?: number | null;
  contextAudioTrimSearch?: AcousticTrimSearchResult | null;
};

export type MultiTakeCandidateManifest = {
  segmentIndex: number;
  candidateIndex: number;
  generationAttempt: number;
  selected: boolean;
  candidatePenaltyScore: number;
  candidatePenaltyReasons: string[];
  contextOverlapUsed: boolean;
  contextFallbackUsed: boolean;
  contextAudioTrimmed: boolean;
  contextAudioTrimSeconds: number | null;
  contextAudioTrimEstimatedSeconds: number | null;
  contextAudioTrimSearch: AcousticTrimSearchResult | null;
  leveledMetrics: SegmentAudioMetrics;
};

export type MultiTakePairwiseSeamScore = {
  boundaryIndex: number;
  previousSegmentIndex: number;
  nextSegmentIndex: number;
  leftCandidateIndex: number;
  rightCandidateIndex: number;
  score: number;
  seamQualityScore: number;
  seamFailureKind: SegmentSeamFailureKind;
  seamFailureReason: string;
  deltaLufs: number | null;
  rmsDeltaDb: number | null;
  gapDurationMs: number;
  spectralDifferenceScore: number | null;
  previousEdgeTone: EdgeToneBandMetrics;
  nextEdgeTone: EdgeToneBandMetrics;
  edgeToneDelta: EdgeToneDeltaMetrics;
  edgeToneMismatchScore: number;
  toneMismatchScore: number;
  speakingRateDeltaWps: number | null;
  speechCutoffRiskBefore: boolean;
  speechCutoffRiskAfter: boolean;
  highTruePeakNearBoundary: boolean;
  seamPassed: boolean;
};

export type MultiTakePairwiseSeamScoreBoundary = {
  boundaryIndex: number;
  previousSegmentIndex: number;
  nextSegmentIndex: number;
  scores: MultiTakePairwiseSeamScore[];
};

export type MultiTakeWorstSeam = {
  boundaryIndex: number;
  score: number;
  seamFailureKind: SegmentSeamFailureKind;
  seamFailureReason: string;
  leftCandidateIndex: number;
  rightCandidateIndex: number;
};

export type MultiTakePathSelection = {
  baselinePath: number[];
  chosenPath: number[];
  baselineTotalScore: number;
  chosenTotalScore: number;
  improvementPercentage: number;
  baselineWorstSeam: MultiTakeWorstSeam | null;
  chosenWorstSeam: MultiTakeWorstSeam | null;
  worstSeamImprovementPercentage: number;
};

export type PublishabilityVerdict = {
  publishable: boolean;
  reason: "passed" | "take_reset";
  killCriteriaFailures: string[];
  thresholds: {
    seamScoreWarning: number;
    minimumAverageImprovementPercentage: number;
    minimumWorstSeamImprovementPercentage: number;
    tonalMixedSeamsPerTenMinutes: number;
  };
};

export type MultiTakeOptimizationManifest = {
  enabled: boolean;
  takeCount: number;
  candidateCounts: number[];
  candidates: MultiTakeCandidateManifest[][];
  pairwiseSeamScoreMatrix: MultiTakePairwiseSeamScoreBoundary[];
  baselinePath: number[];
  chosenPath: number[];
  baselineTotalScore: number;
  chosenTotalScore: number;
  chosenTotalScoreAfterAdjustments: number;
  improvementPercentage: number;
  worstSeamBefore: MultiTakeWorstSeam | null;
  worstSeamAfter: MultiTakeWorstSeam | null;
  worstSeamImprovementPercentage: number;
  finalPublishabilityVerdict: PublishabilityVerdict;
};

export const DEFAULT_OUTPUT_FORMAT: OutputFormat = "mp3";
export const DEFAULT_VOLUME_BOOST: VolumeBoost = "normal";
export const DEFAULT_SMOOTH_JOINS = true;
export const DEFAULT_JOIN_PAUSE_MS = 180;
export const SOFT_JOIN_PAUSE_MS = 120;
export const PARAGRAPH_JOIN_PAUSE_MS = 220;
export const SECTION_JOIN_PAUSE_MS = 320;
export const DEFAULT_MASTERING_STRATEGY: MasteringStrategy = "current-static-master";
export const STANDARD_INTERMEDIATE_SAMPLE_RATE = 24_000;
export const STANDARD_INTERMEDIATE_CHANNELS = 1;
export const TRIM_SILENCE_FILTER =
  "silenceremove=start_periods=1:start_duration=0.02:start_threshold=-45dB:start_silence=0.06:detection=rms,areverse,silenceremove=start_periods=1:start_duration=0.02:start_threshold=-45dB:start_silence=0.10:detection=rms,areverse";
export const SEGMENT_EDGE_FADE_FILTER =
  "afade=t=in:st=0:d=0.010,areverse,afade=t=in:st=0:d=0.010,areverse";
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
export const SEGMENT_SEAM_SCORE_WARNING = 35;
export const SEGMENT_RMS_BOUNDARY_WARNING_DB = 3;
export const SEGMENT_SPECTRAL_MISMATCH_WARNING = 12;
export const SEGMENT_TONE_MISMATCH_WARNING = 18;
export const SEGMENT_EDGE_TONE_MISMATCH_WARNING = 8;
export const SEGMENT_SPEAKING_RATE_DELTA_WARNING_WPS = 0.35;
export const SEGMENT_EDGE_CUTOFF_RMS_WARNING_DB = -20;
export const SEGMENT_EDGE_MATCH_THRESHOLD_LU = 2;
export const SEGMENT_EDGE_MATCH_MAX_CUT_DB = 3;
export const SEGMENT_EDGE_MATCH_WINDOW_SECONDS = 3;
export const SEGMENT_ENTRY_SMOOTHING_MAX_CUT_DB = 1.25;
export const SEGMENT_ENTRY_SMOOTHING_WINDOW_SECONDS = 1.5;
export const DEFAULT_MULTI_TAKE_COUNT = 1;
export const MAX_MULTI_TAKE_COUNT = 5;
export const MULTI_TAKE_MINIMUM_AVERAGE_IMPROVEMENT_PERCENTAGE = 25;
export const MULTI_TAKE_MINIMUM_WORST_SEAM_IMPROVEMENT_PERCENTAGE = 20;
export const MULTI_TAKE_TONAL_MIXED_SEAMS_PER_TEN_MINUTES = 1;
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
  /*turbopackIgnore: true*/ process.cwd(),
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

export async function applySegmentSeamAdjustmentAudioFile({
  inputPath,
  outputPath,
  adjustment,
  durationSeconds
}: {
  inputPath: string;
  outputPath: string;
  adjustment: SegmentSeamAdjustment;
  durationSeconds: number | null;
}): Promise<void> {
  await assertAudioFileReady(inputPath);

  const filter = buildSegmentSeamAdjustmentFilter(adjustment, durationSeconds);

  if (!filter) {
    await copyFile(inputPath, outputPath);
    await assertAudioFileReady(outputPath);
    return;
  }

  await runFfmpeg(
    [
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
    ],
    { stage: "segment-normalization" }
  );

  await assertAudioFileReady(outputPath);
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

export async function measureAudioWindowStats(
  inputPath: string,
  startSeconds: number,
  durationSeconds: number,
  audioFilter = "astats=metadata=0:reset=0"
): Promise<AudioWindowStats> {
  await assertAudioFileReady(inputPath);

  const start = Math.max(0, startSeconds);
  const duration = Math.max(0.05, durationSeconds);
  const { stderr } = await runFfmpegAndCapture(
    [
      "-hide_banner",
      "-nostats",
      "-ss",
      start.toFixed(3),
      "-t",
      duration.toFixed(3),
      "-i",
      inputPath,
      "-vn",
      "-af",
      audioFilter,
      "-f",
      "null",
      "-"
    ],
    { stage: "measurement" }
  );

  return parseAudioWindowStats(stderr);
}

export function computeEdgeToneDelta(
  previous: EdgeToneBandMetrics,
  next: EdgeToneBandMetrics
): EdgeToneDeltaMetrics {
  const lowDeltaDb = computeNullableAbsDelta(previous.lowDb, next.lowDb);
  const midDeltaDb = computeNullableAbsDelta(previous.midDb, next.midDb);
  const highDeltaDb = computeNullableAbsDelta(previous.highDb, next.highDb);
  const deltas = [lowDeltaDb, midDeltaDb, highDeltaDb].filter(
    (value): value is number => value !== null
  );
  const weightedEntries = [
    { value: lowDeltaDb, weight: 0.75 },
    { value: midDeltaDb, weight: 1.25 },
    { value: highDeltaDb, weight: 1.45 }
  ].filter((entry): entry is { value: number; weight: number } => entry.value !== null);
  const weightTotal = weightedEntries.reduce((total, entry) => total + entry.weight, 0);
  const weightedDeltaDb =
    weightTotal <= 0
      ? null
      : roundToTwoDecimals(
          weightedEntries.reduce((total, entry) => total + entry.value * entry.weight, 0) /
            weightTotal
        );

  return {
    lowDeltaDb,
    midDeltaDb,
    highDeltaDb,
    averageDeltaDb:
      deltas.length === 0
        ? null
        : roundToTwoDecimals(deltas.reduce((total, value) => total + value, 0) / deltas.length),
    weightedDeltaDb,
    brightnessExcessDb: computePositiveDelta(next.highDb, previous.highDb),
    presenceExcessDb: computePositiveDelta(next.midDb, previous.midDb)
  };
}

export function computeEdgeToneMismatchScore(delta: EdgeToneDeltaMetrics): number {
  const weightedDelta = delta.weightedDeltaDb;

  if (weightedDelta === null) {
    return 0;
  }

  const continuityPenalty = Math.max(0, weightedDelta - 1.4) * 4.5;
  const brightnessPenalty = Math.max(0, (delta.brightnessExcessDb ?? 0) - 1.2) * 2.2;
  const presencePenalty = Math.max(0, (delta.presenceExcessDb ?? 0) - 1.4) * 1.8;
  return roundToTwoDecimals(
    Math.min(40, continuityPenalty + brightnessPenalty + presencePenalty)
  );
}

export function selectBestAcousticTrimSearchCandidate({
  estimatedTrimSeconds,
  searchRadiusSeconds,
  candidates
}: {
  estimatedTrimSeconds: number;
  searchRadiusSeconds: number;
  candidates: Array<Omit<AcousticTrimSearchCandidate, "score" | "selected">>;
}): AcousticTrimSearchResult {
  const scoredCandidates = candidates.map((candidate) => ({
    ...candidate,
    score: scoreAcousticTrimCandidate(candidate),
    selected: false
  }));
  let selectedIndex = 0;

  for (const [index, candidate] of scoredCandidates.entries()) {
    const selected = scoredCandidates[selectedIndex];

    if (
      !selected ||
      candidate.score < selected.score ||
      (candidate.score === selected.score &&
        Math.abs(candidate.offsetSeconds) < Math.abs(selected.offsetSeconds))
    ) {
      selectedIndex = index;
    }
  }

  const selectedTrimSeconds =
    scoredCandidates[selectedIndex]?.trimSeconds ?? roundToThreeDecimals(estimatedTrimSeconds);

  return {
    estimatedTrimSeconds: roundToThreeDecimals(estimatedTrimSeconds),
    selectedTrimSeconds,
    searchRadiusSeconds: roundToThreeDecimals(searchRadiusSeconds),
    candidates: scoredCandidates.map((candidate, index) => ({
      ...candidate,
      selected: index === selectedIndex
    }))
  };
}

export async function selectAcousticTrimPoint({
  inputPath,
  durationSeconds,
  estimatedTrimSeconds,
  searchRadiusSeconds = 0.4
}: {
  inputPath: string;
  durationSeconds: number;
  estimatedTrimSeconds: number;
  searchRadiusSeconds?: number;
}): Promise<AcousticTrimSearchResult> {
  const maxTrimSeconds = Math.max(0, durationSeconds - 0.5);
  const offsets = [-0.4, -0.27, -0.13, 0, 0.13, 0.27, 0.4].filter(
    (offset) => Math.abs(offset) <= searchRadiusSeconds + 0.001
  );
  const candidateTrimSeconds = [
    ...new Set(
      offsets.map((offset) =>
        roundToThreeDecimals(Math.min(Math.max(0, estimatedTrimSeconds + offset), maxTrimSeconds))
      )
    )
  ];
  const candidates = await Promise.all(
    candidateTrimSeconds.map(async (trimSeconds) => {
      const beforeStats = await measureAudioWindowStats(
        inputPath,
        Math.max(0, trimSeconds - 0.14),
        0.14
      );
      const afterStats = await measureAudioWindowStats(inputPath, trimSeconds, 0.18);
      const combinedRmsDb = averageNullableNumbers([
        beforeStats.rmsLevelDb,
        afterStats.rmsLevelDb
      ]);

      return {
        trimSeconds,
        offsetSeconds: roundToThreeDecimals(trimSeconds - estimatedTrimSeconds),
        beforeRmsDb: beforeStats.rmsLevelDb,
        afterRmsDb: afterStats.rmsLevelDb,
        combinedRmsDb
      };
    })
  );

  return selectBestAcousticTrimSearchCandidate({
    estimatedTrimSeconds,
    searchRadiusSeconds,
    candidates
  });
}

async function measureEdgeToneBandMetrics(
  inputPath: string,
  startSeconds: number,
  durationSeconds: number
): Promise<EdgeToneBandMetrics> {
  const [low, mid, high] = await Promise.all([
    measureAudioWindowStats(inputPath, startSeconds, durationSeconds, edgeToneBandFilter(120, 420)),
    measureAudioWindowStats(inputPath, startSeconds, durationSeconds, edgeToneBandFilter(700, 2500)),
    measureAudioWindowStats(inputPath, startSeconds, durationSeconds, edgeToneBandFilter(3500, 9000))
  ]);

  return {
    lowDb: low.rmsLevelDb,
    midDb: mid.rmsLevelDb,
    highDb: high.rmsLevelDb
  };
}

export async function measureSegmentAudioFile(
  inputPath: string,
  { includeEdgeTone = false }: { includeEdgeTone?: boolean } = {}
): Promise<SegmentAudioMetrics> {
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
  const durationSeconds = timeline?.durationSeconds ?? null;
  const [firstTwoSecondStats, lastTwoSecondStats, leadingEdgeStats, trailingEdgeStats] =
    await Promise.all([
      measureAudioWindowStats(inputPath, 0, 2),
      measureAudioWindowStats(
        inputPath,
        durationSeconds === null ? 0 : Math.max(0, durationSeconds - 2),
        2
      ),
      measureAudioWindowStats(inputPath, 0, 0.25),
      measureAudioWindowStats(
        inputPath,
        durationSeconds === null ? 0 : Math.max(0, durationSeconds - 0.25),
        0.25
      )
    ]).catch((error) => {
      console.warn(
        "[segment-metrics] edge window analysis unavailable",
        JSON.stringify({
          filePath: inputPath,
          reason: error instanceof Error ? error.message : "Unknown edge-window measurement failure."
        })
      );
      return [null, null, null, null] as const;
    });
  const [firstTwoSecondEdgeTone, lastTwoSecondEdgeTone] = includeEdgeTone
    ? await Promise.all([
        measureEdgeToneBandMetrics(inputPath, 0, 2),
        measureEdgeToneBandMetrics(
          inputPath,
          durationSeconds === null ? 0 : Math.max(0, durationSeconds - 2),
          2
        )
      ]).catch((error) => {
        console.warn(
          "[segment-metrics] edge-tone analysis unavailable",
          JSON.stringify({
            filePath: inputPath,
            reason:
              error instanceof Error ? error.message : "Unknown edge-tone measurement failure."
          })
        );
        return [nullEdgeToneBandMetrics(), nullEdgeToneBandMetrics()] as const;
      })
    : [nullEdgeToneBandMetrics(), nullEdgeToneBandMetrics()];
  const largestInternalJump = timeline?.largestJumps[0] ?? null;
  const internalDriftLufs =
    firstWindowLoudness === null || lastWindowLoudness === null
      ? null
      : roundToTwoDecimals(Math.abs(lastWindowLoudness - firstWindowLoudness));

  return {
    durationSeconds,
    integratedLoudness: timeline?.integratedLoudness ?? fallbackMetrics?.integratedLoudness ?? null,
    truePeak: timeline?.truePeak ?? fallbackMetrics?.truePeak ?? null,
    maxVolume: maxVolume ?? fallbackMetrics?.maxVolume ?? null,
    loudnessRange: timeline?.loudnessRange ?? null,
    shortTermByTimestamp,
    firstWindowLoudness,
    lastWindowLoudness,
    firstFiveSecondLoudness: averageEdgeLoudness(shortTermByTimestamp, durationSeconds, "first", 5),
    lastFiveSecondLoudness: averageEdgeLoudness(shortTermByTimestamp, durationSeconds, "last", 5),
    firstTwoSecondRmsDb: firstTwoSecondStats?.rmsLevelDb ?? null,
    lastTwoSecondRmsDb: lastTwoSecondStats?.rmsLevelDb ?? null,
    firstTwoSecondPeakDb: firstTwoSecondStats?.peakLevelDb ?? null,
    lastTwoSecondPeakDb: lastTwoSecondStats?.peakLevelDb ?? null,
    firstTwoSecondZeroCrossingRate: firstTwoSecondStats?.zeroCrossingsRate ?? null,
    lastTwoSecondZeroCrossingRate: lastTwoSecondStats?.zeroCrossingsRate ?? null,
    firstTwoSecondEdgeTone,
    lastTwoSecondEdgeTone,
    leadingEdgeRmsDb: leadingEdgeStats?.rmsLevelDb ?? null,
    trailingEdgeRmsDb: trailingEdgeStats?.rmsLevelDb ?? null,
    leadingSpeechCutoffRisk: isSpeechCutoffRisk(leadingEdgeStats?.rmsLevelDb ?? null),
    trailingSpeechCutoffRisk: isSpeechCutoffRisk(trailingEdgeStats?.rmsLevelDb ?? null),
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

export function buildSegmentJoinPlan(
  segmentTexts: string[],
  smoothJoins = true
): SegmentJoinPlan[] {
  const plan: SegmentJoinPlan[] = [];

  for (let index = 0; index < segmentTexts.length - 1; index += 1) {
    const previousText = segmentTexts[index] ?? "";
    const nextText = segmentTexts[index + 1] ?? "";
    const classification = classifyJoinPause(previousText, nextText, smoothJoins);

    plan.push({
      boundaryIndex: index + 1,
      previousSegmentIndex: index + 1,
      nextSegmentIndex: index + 2,
      pauseMs: classification.pauseMs,
      reason: classification.reason
    });
  }

  return plan;
}

export function getAdaptiveJoinPauseMs({
  previousText,
  nextText,
  smoothJoins = true
}: {
  previousText: string;
  nextText: string;
  smoothJoins?: boolean;
}): number {
  return classifyJoinPause(previousText, nextText, smoothJoins).pauseMs;
}

export function computeToneMismatchScore({
  spectralDifferenceScore,
  speakingRateDeltaWps,
  edgeToneMismatchScore = 0,
  toneSeamScoringEnabled = true
}: {
  spectralDifferenceScore: number | null;
  speakingRateDeltaWps: number | null;
  edgeToneMismatchScore?: number;
  toneSeamScoringEnabled?: boolean;
}): number {
  if (!toneSeamScoringEnabled) {
    return 0;
  }

  let score = 0;

  if (
    spectralDifferenceScore !== null &&
    spectralDifferenceScore > SEGMENT_SPECTRAL_MISMATCH_WARNING
  ) {
    score += (spectralDifferenceScore - SEGMENT_SPECTRAL_MISMATCH_WARNING) * 1.5;
  }

  if (
    speakingRateDeltaWps !== null &&
    speakingRateDeltaWps > SEGMENT_SPEAKING_RATE_DELTA_WARNING_WPS
  ) {
    score +=
      (speakingRateDeltaWps - SEGMENT_SPEAKING_RATE_DELTA_WARNING_WPS) * 42;
  }

  if (edgeToneMismatchScore > SEGMENT_EDGE_TONE_MISMATCH_WARNING) {
    score +=
      SEGMENT_EDGE_TONE_MISMATCH_WARNING +
      (edgeToneMismatchScore - SEGMENT_EDGE_TONE_MISMATCH_WARNING) * 1.4;
  } else {
    score += edgeToneMismatchScore * 0.65;
  }

  return roundToTwoDecimals(Math.min(100, score));
}

export function computeSeamQualityScore({
  loudnessDeltaLufs,
  rmsDeltaDb,
  gapDurationMs,
  spectralDifferenceScore,
  toneMismatchScore = 0,
  edgeToneMismatchScore = 0,
  speechCutoffRiskBefore,
  speechCutoffRiskAfter,
  highTruePeakNearBoundary
}: {
  loudnessDeltaLufs: number | null;
  rmsDeltaDb: number | null;
  gapDurationMs: number;
  spectralDifferenceScore: number | null;
  toneMismatchScore?: number;
  edgeToneMismatchScore?: number;
  speechCutoffRiskBefore: boolean;
  speechCutoffRiskAfter: boolean;
  highTruePeakNearBoundary: boolean;
}): number {
  let score = 0;

  if (loudnessDeltaLufs !== null && loudnessDeltaLufs > SEGMENT_BOUNDARY_DELTA_WARNING_LU) {
    score += (loudnessDeltaLufs - SEGMENT_BOUNDARY_DELTA_WARNING_LU) * 12;
  }

  if (rmsDeltaDb !== null && rmsDeltaDb > SEGMENT_RMS_BOUNDARY_WARNING_DB) {
    score += (rmsDeltaDb - SEGMENT_RMS_BOUNDARY_WARNING_DB) * 10;
  }

  if (gapDurationMs > SECTION_JOIN_PAUSE_MS) {
    score += (gapDurationMs - SECTION_JOIN_PAUSE_MS) / 4;
  } else if (gapDurationMs > PARAGRAPH_JOIN_PAUSE_MS + 40) {
    score += (gapDurationMs - PARAGRAPH_JOIN_PAUSE_MS - 40) / 8;
  } else if (gapDurationMs > 0 && gapDurationMs < SOFT_JOIN_PAUSE_MS - 40) {
    score += (SOFT_JOIN_PAUSE_MS - 40 - gapDurationMs) / 3;
  }

  if (
    spectralDifferenceScore !== null &&
    spectralDifferenceScore > SEGMENT_SPECTRAL_MISMATCH_WARNING
  ) {
    score += (spectralDifferenceScore - SEGMENT_SPECTRAL_MISMATCH_WARNING) * 1.2;
  }

  if (edgeToneMismatchScore > 0) {
    score += edgeToneMismatchScore * 0.9;
  }

  if (toneMismatchScore > SEGMENT_TONE_MISMATCH_WARNING) {
    score += toneMismatchScore;
  }

  if (speechCutoffRiskBefore) {
    score += 24;
  }

  if (speechCutoffRiskAfter) {
    score += 24;
  }

  if (highTruePeakNearBoundary) {
    score += 8;
  }

  return roundToTwoDecimals(Math.min(100, score));
}

export function selectSeamRegenerationTargets(
  boundaries: SegmentBoundaryDiagnostic[],
  segmentMetrics: SegmentAudioMetrics[],
  maxSegments = 2
): number[] {
  const targets = new Set<number>();
  const failedBoundaries = boundaries
    .filter((boundary) => !boundary.seamPassed)
    .sort((left, right) => right.seamQualityScore - left.seamQualityScore);

  for (const boundary of failedBoundaries) {
    if (targets.size >= maxSegments) {
      break;
    }

    const previousIndex = boundary.previousSegmentIndex;
    const nextIndex = boundary.nextSegmentIndex;
    const previousMetrics = segmentMetrics[previousIndex - 1];
    const nextMetrics = segmentMetrics[nextIndex - 1];

    if (boundary.seamFailureKind === "tonal") {
      targets.add(nextIndex);
    } else if (boundary.seamFailureKind === "mixed" && boundary.suddenToneMismatch) {
      targets.add(nextIndex);
    } else if (boundary.speechCutoffRiskBefore) {
      targets.add(previousIndex);
    } else if (boundary.speechCutoffRiskAfter) {
      targets.add(nextIndex);
    } else if ((previousMetrics?.internalDriftLufs ?? 0) > SEGMENT_INTERNAL_DRIFT_WARNING_LU) {
      targets.add(previousIndex);
    } else {
      targets.add(nextIndex);
    }
  }

  return [...targets].slice(0, maxSegments);
}

export function computeSegmentSeamAdjustments(
  boundaries: SegmentBoundaryDiagnostic[],
  segmentCount: number
): SegmentSeamAdjustment[] {
  const adjustments: SegmentSeamAdjustment[] = Array.from(
    { length: segmentCount },
    (_unused, index) => ({
      segmentIndex: index + 1,
      startCutDb: 0,
      endCutDb: 0,
      entrySmoothingCutDb: 0,
      entrySmoothingWindowSeconds: SEGMENT_ENTRY_SMOOTHING_WINDOW_SECONDS,
      entrySmoothingBoundaryIndex: null,
      entrySmoothingReason: null,
      filter: null
    })
  );

  for (const boundary of boundaries) {
    if (boundary.deltaLufs !== null && boundary.deltaLufs > SEGMENT_EDGE_MATCH_THRESHOLD_LU) {
      const before = boundary.previousLast5sLoudness;
      const after = boundary.nextFirst5sLoudness;

      if (before !== null && after !== null) {
        const cutDb = roundToTwoDecimals(
          Math.min(
            SEGMENT_EDGE_MATCH_MAX_CUT_DB,
            boundary.deltaLufs - SEGMENT_EDGE_MATCH_THRESHOLD_LU
          )
        );

        if (cutDb > 0) {
          if (before > after) {
            const previous = adjustments[boundary.previousSegmentIndex - 1];

            if (previous) {
              previous.endCutDb = Math.max(previous.endCutDb, cutDb);
            }
          } else {
            const next = adjustments[boundary.nextSegmentIndex - 1];

            if (next) {
              next.startCutDb = Math.max(next.startCutDb, cutDb);
            }
          }
        }
      }
    }

    const smoothing = computeEntrySmoothingForBoundary(boundary);

    if (!smoothing) {
      continue;
    }

    const next = adjustments[boundary.nextSegmentIndex - 1];

    if (!next || smoothing.cutDb <= next.entrySmoothingCutDb) {
      continue;
    }

    next.entrySmoothingCutDb = smoothing.cutDb;
    next.entrySmoothingWindowSeconds = smoothing.windowSeconds;
    next.entrySmoothingBoundaryIndex = boundary.boundaryIndex;
    next.entrySmoothingReason = smoothing.reason;
  }

  return adjustments.map((adjustment) => ({
    ...adjustment,
    startCutDb: roundToTwoDecimals(adjustment.startCutDb),
    endCutDb: roundToTwoDecimals(adjustment.endCutDb),
    entrySmoothingCutDb: roundToTwoDecimals(adjustment.entrySmoothingCutDb),
    filter: null
  }));
}

function computeEntrySmoothingForBoundary(
  boundary: SegmentBoundaryDiagnostic
): { cutDb: number; windowSeconds: number; reason: string } | null {
  if (boundary.seamFailureKind !== "tonal" && boundary.seamFailureKind !== "mixed") {
    return null;
  }

  const brightnessExcess = boundary.edgeToneDelta.brightnessExcessDb ?? 0;
  const presenceExcess = boundary.edgeToneDelta.presenceExcessDb ?? 0;
  const rmsExcess =
    boundary.previousLast2sRmsDb === null || boundary.nextFirst2sRmsDb === null
      ? 0
      : Math.max(0, boundary.nextFirst2sRmsDb - boundary.previousLast2sRmsDb);
  const loudnessExcess =
    boundary.previousLast5sLoudness === null || boundary.nextFirst5sLoudness === null
      ? 0
      : Math.max(0, boundary.nextFirst5sLoudness - boundary.previousLast5sLoudness);
  const tonalExcess = Math.max(
    brightnessExcess - 1.1,
    presenceExcess - 1.4,
    rmsExcess - 1,
    loudnessExcess - 0.8
  );

  if (tonalExcess <= 0) {
    return null;
  }

  const cutDb = roundToTwoDecimals(
    Math.min(SEGMENT_ENTRY_SMOOTHING_MAX_CUT_DB, Math.max(0.75, tonalExcess * 0.45))
  );

  return {
    cutDb,
    windowSeconds: SEGMENT_ENTRY_SMOOTHING_WINDOW_SECONDS,
    reason: [
      `boundary-${boundary.boundaryIndex}`,
      `kind-${boundary.seamFailureKind}`,
      `brightness-${brightnessExcess.toFixed(2)}`,
      `presence-${presenceExcess.toFixed(2)}`,
      `rms-${rmsExcess.toFixed(2)}`,
      `loudness-${loudnessExcess.toFixed(2)}`
    ].join(":")
  };
}

export function buildSegmentSeamAdjustmentFilter(
  adjustment: Pick<SegmentSeamAdjustment, "startCutDb" | "endCutDb"> &
    Partial<Pick<SegmentSeamAdjustment, "entrySmoothingCutDb" | "entrySmoothingWindowSeconds">>,
  durationSeconds: number | null
): string | null {
  const filters: string[] = [];
  const safeWindowSeconds = SEGMENT_EDGE_MATCH_WINDOW_SECONDS;

  const entrySmoothingCutDb =
    "entrySmoothingCutDb" in adjustment
      ? Math.min(
          SEGMENT_ENTRY_SMOOTHING_MAX_CUT_DB,
          Math.max(0, adjustment.entrySmoothingCutDb ?? 0)
        )
      : 0;
  const entrySmoothingWindowSeconds =
    "entrySmoothingWindowSeconds" in adjustment
      ? Math.min(
          2,
          Math.max(1, adjustment.entrySmoothingWindowSeconds ?? SEGMENT_ENTRY_SMOOTHING_WINDOW_SECONDS)
        )
      : SEGMENT_ENTRY_SMOOTHING_WINDOW_SECONDS;
  const remainingStartCutDb = Math.max(0, adjustment.startCutDb - entrySmoothingCutDb);

  if (entrySmoothingCutDb >= 0.05) {
    filters.push(
      `volume='if(lt(t\\,${entrySmoothingWindowSeconds.toFixed(
        2
      )})\\,exp(log(10)*(-${entrySmoothingCutDb.toFixed(
        2
      )}*(1-t/${entrySmoothingWindowSeconds.toFixed(2)}))/20)\\,1)':eval=frame`
    );
  }

  if (remainingStartCutDb >= 0.05) {
    filters.push(
      `volume='if(lt(t\\,${safeWindowSeconds.toFixed(2)})\\,exp(log(10)*(-${remainingStartCutDb.toFixed(
        2
      )}*(1-t/${safeWindowSeconds.toFixed(2)}))/20)\\,1)':eval=frame`
    );
  }

  if (
    adjustment.endCutDb >= 0.05 &&
    durationSeconds !== null &&
    Number.isFinite(durationSeconds) &&
    durationSeconds > 0
  ) {
    const startSeconds = Math.max(0, durationSeconds - safeWindowSeconds);
    filters.push(
      `volume='if(lt(t\\,${startSeconds.toFixed(2)})\\,1\\,exp(log(10)*(-${adjustment.endCutDb.toFixed(
        2
      )}*(t-${startSeconds.toFixed(2)})/${safeWindowSeconds.toFixed(2)})/20))':eval=frame`
    );
  }

  if (filters.length === 0) {
    return null;
  }

  filters.push(`alimiter=limit=${SEGMENT_LEVELING_SETTINGS.limiter}:level=disabled`);
  return filters.join(",");
}

export function buildSegmentBoundaryDiagnostics(
  segmentMetrics: SegmentAudioMetrics[],
  pauseDurationsSeconds: number | number[] = 0,
  boundaryThresholdLufs = SEGMENT_BOUNDARY_DELTA_WARNING_LU,
  nearBoundaryThresholdLufs = SEGMENT_NEAR_BOUNDARY_JUMP_WARNING_LU,
  {
    wordCounts,
    toneSeamScoringEnabled = true
  }: {
    wordCounts?: number[];
    toneSeamScoringEnabled?: boolean;
  } = {}
): SegmentBoundaryDiagnostic[] {
  const diagnostics: SegmentBoundaryDiagnostic[] = [];
  let segmentStartSeconds: number | null = 0;

  for (let index = 0; index < segmentMetrics.length - 1; index += 1) {
    const current = segmentMetrics[index];
    const next = segmentMetrics[index + 1];
    const pauseDurationSeconds = Array.isArray(pauseDurationsSeconds)
      ? (pauseDurationsSeconds[index] ?? 0)
      : pauseDurationsSeconds;
    const boundaryTimestampSeconds: number | null =
      segmentStartSeconds === null || current.durationSeconds === null
        ? null
        : roundToTwoDecimals(segmentStartSeconds + current.durationSeconds);
    const nextSpeechTimestampSeconds: number | null =
      boundaryTimestampSeconds === null
        ? null
        : roundToTwoDecimals(boundaryTimestampSeconds + pauseDurationSeconds);
    const deltaLufs =
      current.lastFiveSecondLoudness === null || next.firstFiveSecondLoudness === null
        ? null
        : roundToTwoDecimals(
            Math.abs(next.firstFiveSecondLoudness - current.lastFiveSecondLoudness)
          );
    const rmsDeltaDb =
      current.lastTwoSecondRmsDb === null || next.firstTwoSecondRmsDb === null
        ? null
        : roundToTwoDecimals(Math.abs(next.firstTwoSecondRmsDb - current.lastTwoSecondRmsDb));
    const gapDurationMs = Math.round(pauseDurationSeconds * 1000);
    const spectralDifferenceScore = computeSpectralDifferenceScore({
      previousZeroCrossingRate: current.lastTwoSecondZeroCrossingRate,
      nextZeroCrossingRate: next.firstTwoSecondZeroCrossingRate,
      rmsDeltaDb
    });
    const previousEdgeTone = current.lastTwoSecondEdgeTone;
    const nextEdgeTone = next.firstTwoSecondEdgeTone;
    const edgeToneDelta = computeEdgeToneDelta(previousEdgeTone, nextEdgeTone);
    const edgeToneMismatchScore = computeEdgeToneMismatchScore(edgeToneDelta);
    const previousSpeakingRateWps = computeSpeakingRateWps(
      wordCounts?.[index],
      current.durationSeconds
    );
    const nextSpeakingRateWps = computeSpeakingRateWps(
      wordCounts?.[index + 1],
      next.durationSeconds
    );
    const speakingRateDeltaWps =
      previousSpeakingRateWps === null || nextSpeakingRateWps === null
        ? null
        : roundToTwoDecimals(Math.abs(nextSpeakingRateWps - previousSpeakingRateWps));
    const toneMismatchScore = computeToneMismatchScore({
      spectralDifferenceScore,
      speakingRateDeltaWps,
      edgeToneMismatchScore,
      toneSeamScoringEnabled
    });
    const highTruePeakNearBoundary =
      (current.truePeak !== null && current.truePeak > SEGMENT_LEVELING_SETTINGS.truePeak + 0.5) ||
      (next.truePeak !== null && next.truePeak > SEGMENT_LEVELING_SETTINGS.truePeak + 0.5);
    const speechCutoffRiskBefore = current.trailingSpeechCutoffRisk;
    const speechCutoffRiskAfter = next.leadingSpeechCutoffRisk;
    const seamQualityScore = computeSeamQualityScore({
      loudnessDeltaLufs: deltaLufs,
      rmsDeltaDb,
      gapDurationMs,
      spectralDifferenceScore,
      toneMismatchScore,
      edgeToneMismatchScore,
      speechCutoffRiskBefore,
      speechCutoffRiskAfter,
      highTruePeakNearBoundary
    });
    const suddenToneMismatch =
      toneSeamScoringEnabled && toneMismatchScore > SEGMENT_TONE_MISMATCH_WARNING;
    const mechanicalFailed =
      (deltaLufs !== null && deltaLufs > nearBoundaryThresholdLufs) ||
      (rmsDeltaDb !== null && rmsDeltaDb > SEGMENT_RMS_BOUNDARY_WARNING_DB) ||
      speechCutoffRiskBefore ||
      speechCutoffRiskAfter ||
      highTruePeakNearBoundary ||
      gapDurationMs > SECTION_JOIN_PAUSE_MS;
    const seamPassed =
      seamQualityScore < SEGMENT_SEAM_SCORE_WARNING && !mechanicalFailed && !suddenToneMismatch;
    const seamFailureKind: SegmentSeamFailureKind = seamPassed
      ? "passed"
      : mechanicalFailed && suddenToneMismatch
        ? "mixed"
        : suddenToneMismatch
          ? "tonal"
          : "mechanical";
    const seamFailureReason = describeSeamFailure({
      seamPassed,
      seamFailureKind,
      deltaLufs,
      rmsDeltaDb,
      gapDurationMs,
      spectralDifferenceScore,
      speakingRateDeltaWps,
      toneMismatchScore,
      edgeToneMismatchScore,
      speechCutoffRiskBefore,
      speechCutoffRiskAfter
    });

    diagnostics.push({
      boundaryIndex: index + 1,
      previousSegmentIndex: index + 1,
      nextSegmentIndex: index + 2,
      boundaryTimestampSeconds,
      nextSpeechTimestampSeconds,
      beforeLoudness: current.lastFiveSecondLoudness,
      afterLoudness: next.firstFiveSecondLoudness,
      previousLast5sLoudness: current.lastFiveSecondLoudness,
      nextFirst5sLoudness: next.firstFiveSecondLoudness,
      deltaLufs,
      exceedsThreshold: deltaLufs !== null && deltaLufs > boundaryThresholdLufs,
      nearBoundaryJumpLufs: deltaLufs,
      nearBoundaryJumpExceedsThreshold:
        deltaLufs !== null && deltaLufs > nearBoundaryThresholdLufs,
      previousLast2sRmsDb: current.lastTwoSecondRmsDb,
      nextFirst2sRmsDb: next.firstTwoSecondRmsDb,
      rmsDeltaDb,
      gapDurationMs,
      previousTruePeak: current.truePeak,
      nextTruePeak: next.truePeak,
      highTruePeakNearBoundary,
      speechCutoffRiskBefore,
      speechCutoffRiskAfter,
      previousEdgeTone,
      nextEdgeTone,
      edgeToneDelta,
      edgeToneMismatchScore,
      spectralDifferenceScore,
      suddenToneMismatch,
      previousSpeakingRateWps,
      nextSpeakingRateWps,
      speakingRateDeltaWps,
      toneMismatchScore,
      seamFailureKind,
      seamFailureReason,
      previousContextTail: null,
      nextContextHead: null,
      contextOverlapUsed: false,
      regenerationAttempts: [],
      boundaryRepair: null,
      entrySmoothingApplied: false,
      entrySmoothingCutDb: 0,
      entrySmoothingReason: null,
      seamQualityScore,
      seamPassed,
      seamClipPath: null
    });

    segmentStartSeconds =
      nextSpeechTimestampSeconds === null ? null : nextSpeechTimestampSeconds;
  }

  return diagnostics;
}

export function resolveMultiTakeCount(
  value: string | undefined,
  {
    defaultValue = DEFAULT_MULTI_TAKE_COUNT,
    maxValue = MAX_MULTI_TAKE_COUNT
  }: {
    defaultValue?: number;
    maxValue?: number;
  } = {}
): number {
  const fallback = Math.max(1, Math.floor(defaultValue));

  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const trimmed = value.trim();

  if (!/^\d+$/.test(trimmed)) {
    return fallback;
  }

  const parsed = Number.parseInt(trimmed, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.min(Math.max(1, Math.floor(maxValue)), parsed);
}

export function computeMultiTakeCandidatePenalty(
  candidate: Pick<
    MultiTakeCandidateInput,
    | "metrics"
    | "generationAttempt"
    | "contextFallbackUsed"
    | "contextAudioTrimmed"
    | "contextAudioTrimSeconds"
  >
): MultiTakeCandidatePenalty {
  const reasons: string[] = [];
  let score = 0;
  const metrics = candidate.metrics;

  if (metrics.integratedLoudness === null) {
    score += 4;
    reasons.push("missing-integrated-loudness");
  }

  if (metrics.truePeak === null) {
    score += 4;
    reasons.push("missing-true-peak");
  } else if (metrics.truePeak > SEGMENT_LEVELING_SETTINGS.truePeak + 0.5) {
    score += 8;
    reasons.push("high-true-peak");
  }

  if (
    metrics.internalDriftLufs !== null &&
    metrics.internalDriftLufs > SEGMENT_INTERNAL_DRIFT_WARNING_LU
  ) {
    score += (metrics.internalDriftLufs - SEGMENT_INTERNAL_DRIFT_WARNING_LU) * 5;
    reasons.push("internal-drift");
  }

  if (metrics.leadingSpeechCutoffRisk) {
    score += 12;
    reasons.push("leading-speech-cutoff-risk");
  }

  if (metrics.trailingSpeechCutoffRisk) {
    score += 12;
    reasons.push("trailing-speech-cutoff-risk");
  }

  if (candidate.contextFallbackUsed) {
    score += 6;
    reasons.push("context-fallback");
  }

  const contextAudioTrimSeconds = candidate.contextAudioTrimSeconds ?? null;

  if (
    candidate.contextAudioTrimmed &&
    (contextAudioTrimSeconds === null ||
      !Number.isFinite(contextAudioTrimSeconds) ||
      contextAudioTrimSeconds < 0)
  ) {
    score += 6;
    reasons.push("invalid-context-trim");
  }

  if ((candidate.generationAttempt ?? 1) > 1) {
    score += 1;
    reasons.push("regenerated-take");
  }

  return {
    score: roundToTwoDecimals(score),
    reasons
  };
}

export function buildMultiTakePairwiseSeamScoreMatrix({
  candidates,
  joinPlan,
  wordCounts,
  toneSeamScoringEnabled = true
}: {
  candidates: MultiTakeCandidateInput[][];
  joinPlan: Pick<SegmentJoinPlan, "pauseMs">[];
  wordCounts: number[];
  toneSeamScoringEnabled?: boolean;
}): MultiTakePairwiseSeamScoreBoundary[] {
  const matrix: MultiTakePairwiseSeamScoreBoundary[] = [];

  for (
    let boundaryArrayIndex = 0;
    boundaryArrayIndex < candidates.length - 1;
    boundaryArrayIndex += 1
  ) {
    const previousCandidates = candidates[boundaryArrayIndex] ?? [];
    const nextCandidates = candidates[boundaryArrayIndex + 1] ?? [];
    const boundaryIndex = boundaryArrayIndex + 1;
    const scores: MultiTakePairwiseSeamScore[] = [];

    for (const previousCandidate of previousCandidates) {
      for (const nextCandidate of nextCandidates) {
        const diagnostic = buildSegmentBoundaryDiagnostics(
          [previousCandidate.metrics, nextCandidate.metrics],
          [(joinPlan[boundaryArrayIndex]?.pauseMs ?? 0) / 1000],
          undefined,
          undefined,
          {
            wordCounts: [
              wordCounts[boundaryArrayIndex] ?? 0,
              wordCounts[boundaryArrayIndex + 1] ?? 0
            ],
            toneSeamScoringEnabled
          }
        )[0];

        if (!diagnostic) {
          continue;
        }

        scores.push({
          boundaryIndex,
          previousSegmentIndex: boundaryIndex,
          nextSegmentIndex: boundaryIndex + 1,
          leftCandidateIndex: previousCandidate.candidateIndex,
          rightCandidateIndex: nextCandidate.candidateIndex,
          score: diagnostic.seamQualityScore,
          seamQualityScore: diagnostic.seamQualityScore,
          seamFailureKind: diagnostic.seamFailureKind,
          seamFailureReason: diagnostic.seamFailureReason,
          deltaLufs: diagnostic.deltaLufs,
          rmsDeltaDb: diagnostic.rmsDeltaDb,
          gapDurationMs: diagnostic.gapDurationMs,
          spectralDifferenceScore: diagnostic.spectralDifferenceScore,
          previousEdgeTone: diagnostic.previousEdgeTone,
          nextEdgeTone: diagnostic.nextEdgeTone,
          edgeToneDelta: diagnostic.edgeToneDelta,
          edgeToneMismatchScore: diagnostic.edgeToneMismatchScore,
          toneMismatchScore: diagnostic.toneMismatchScore,
          speakingRateDeltaWps: diagnostic.speakingRateDeltaWps,
          speechCutoffRiskBefore: diagnostic.speechCutoffRiskBefore,
          speechCutoffRiskAfter: diagnostic.speechCutoffRiskAfter,
          highTruePeakNearBoundary: diagnostic.highTruePeakNearBoundary,
          seamPassed: diagnostic.seamPassed
        });
      }
    }

    matrix.push({
      boundaryIndex,
      previousSegmentIndex: boundaryIndex,
      nextSegmentIndex: boundaryIndex + 1,
      scores
    });
  }

  return matrix;
}

export function selectBestMultiTakePath({
  candidatePenaltyScores,
  pairwiseSeamScoreMatrix
}: {
  candidatePenaltyScores: number[][];
  pairwiseSeamScoreMatrix: MultiTakePairwiseSeamScoreBoundary[];
}): MultiTakePathSelection {
  if (candidatePenaltyScores.length === 0) {
    return {
      baselinePath: [],
      chosenPath: [],
      baselineTotalScore: 0,
      chosenTotalScore: 0,
      improvementPercentage: 0,
      baselineWorstSeam: null,
      chosenWorstSeam: null,
      worstSeamImprovementPercentage: 0
    };
  }

  const baselinePath = candidatePenaltyScores.map(() => 0);
  const dp: number[][] = [];
  const backtrack: number[][] = [];

  dp[0] = candidatePenaltyScores[0].map((penalty) => roundToTwoDecimals(penalty));
  backtrack[0] = candidatePenaltyScores[0].map(() => -1);

  for (let segmentIndex = 1; segmentIndex < candidatePenaltyScores.length; segmentIndex += 1) {
    dp[segmentIndex] = [];
    backtrack[segmentIndex] = [];

    for (
      let candidateIndex = 0;
      candidateIndex < candidatePenaltyScores[segmentIndex].length;
      candidateIndex += 1
    ) {
      let bestScore = Number.POSITIVE_INFINITY;
      let bestPreviousCandidateIndex = 0;

      for (
        let previousCandidateIndex = 0;
        previousCandidateIndex < candidatePenaltyScores[segmentIndex - 1].length;
        previousCandidateIndex += 1
      ) {
        const seamScore =
          findPairwiseScore(
            pairwiseSeamScoreMatrix[segmentIndex - 1],
            previousCandidateIndex,
            candidateIndex
          )?.score ?? Number.POSITIVE_INFINITY;
        const candidateScore =
          (dp[segmentIndex - 1]?.[previousCandidateIndex] ?? Number.POSITIVE_INFINITY) +
          seamScore +
          (candidatePenaltyScores[segmentIndex]?.[candidateIndex] ?? 0);

        if (candidateScore < bestScore) {
          bestScore = candidateScore;
          bestPreviousCandidateIndex = previousCandidateIndex;
        }
      }

      dp[segmentIndex][candidateIndex] = roundToTwoDecimals(bestScore);
      backtrack[segmentIndex][candidateIndex] = bestPreviousCandidateIndex;
    }
  }

  const finalScores = dp[dp.length - 1] ?? [];
  let chosenFinalCandidateIndex = 0;
  let chosenScore = finalScores[0] ?? 0;

  for (const [candidateIndex, score] of finalScores.entries()) {
    if (score < chosenScore) {
      chosenScore = score;
      chosenFinalCandidateIndex = candidateIndex;
    }
  }

  const chosenPath = Array.from({ length: candidatePenaltyScores.length }, () => 0);
  chosenPath[chosenPath.length - 1] = chosenFinalCandidateIndex;

  for (let segmentIndex = candidatePenaltyScores.length - 1; segmentIndex > 0; segmentIndex -= 1) {
    chosenPath[segmentIndex - 1] = backtrack[segmentIndex]?.[chosenPath[segmentIndex]] ?? 0;
  }

  const baselineTotalScore = scoreMultiTakePath({
    path: baselinePath,
    candidatePenaltyScores,
    pairwiseSeamScoreMatrix
  });
  const chosenTotalScore = scoreMultiTakePath({
    path: chosenPath,
    candidatePenaltyScores,
    pairwiseSeamScoreMatrix
  });
  const baselineWorstSeam = findWorstSeamForPath({
    path: baselinePath,
    pairwiseSeamScoreMatrix
  });
  const chosenWorstSeam = findWorstSeamForPath({
    path: chosenPath,
    pairwiseSeamScoreMatrix
  });

  return {
    baselinePath,
    chosenPath,
    baselineTotalScore,
    chosenTotalScore,
    improvementPercentage: computeImprovementPercentage(
      baselineTotalScore,
      chosenTotalScore
    ),
    baselineWorstSeam,
    chosenWorstSeam,
    worstSeamImprovementPercentage: computeImprovementPercentage(
      baselineWorstSeam?.score ?? 0,
      chosenWorstSeam?.score ?? 0
    )
  };
}

export function scoreMultiTakePath({
  path,
  candidatePenaltyScores,
  pairwiseSeamScoreMatrix
}: {
  path: number[];
  candidatePenaltyScores: number[][];
  pairwiseSeamScoreMatrix: MultiTakePairwiseSeamScoreBoundary[];
}): number {
  let score = 0;

  for (const [segmentIndex, candidateIndex] of path.entries()) {
    score += candidatePenaltyScores[segmentIndex]?.[candidateIndex] ?? 0;

    if (segmentIndex === 0) {
      continue;
    }

    score +=
      findPairwiseScore(
        pairwiseSeamScoreMatrix[segmentIndex - 1],
        path[segmentIndex - 1] ?? 0,
        candidateIndex
      )?.score ?? 0;
  }

  return roundToTwoDecimals(score);
}

export function evaluateSegmentedPublishability({
  boundaries,
  multiTakeEnabled,
  improvementPercentage,
  worstSeamImprovementPercentage,
  durationSeconds
}: {
  boundaries: SegmentBoundaryDiagnostic[];
  multiTakeEnabled: boolean;
  improvementPercentage: number;
  worstSeamImprovementPercentage: number;
  durationSeconds: number | null;
}): PublishabilityVerdict {
  const failures: string[] = [];
  const worstSeamScore = boundaries.reduce(
    (highest, boundary) => Math.max(highest, boundary.seamQualityScore),
    0
  );
  const tonalMixedFailures = boundaries.filter(
    (boundary) =>
      !boundary.seamPassed &&
      (boundary.seamFailureKind === "tonal" || boundary.seamFailureKind === "mixed")
  );
  const tonalOnlyFailures = boundaries.filter(
    (boundary) => !boundary.seamPassed && boundary.seamFailureKind === "tonal"
  );
  const tenMinuteBlocks =
    durationSeconds === null || durationSeconds <= 0
      ? 1
      : Math.max(1, Math.ceil(durationSeconds / 600));
  const allowedTonalMixedFailures =
    MULTI_TAKE_TONAL_MIXED_SEAMS_PER_TEN_MINUTES * tenMinuteBlocks;

  if (worstSeamScore >= SEGMENT_SEAM_SCORE_WARNING) {
    failures.push("worst_seam_score_threshold");
  }

  if (
    multiTakeEnabled &&
    improvementPercentage < MULTI_TAKE_MINIMUM_AVERAGE_IMPROVEMENT_PERCENTAGE
  ) {
    failures.push("average_improvement_below_threshold");
  }

  if (
    multiTakeEnabled &&
    worstSeamImprovementPercentage < MULTI_TAKE_MINIMUM_WORST_SEAM_IMPROVEMENT_PERCENTAGE
  ) {
    failures.push("worst_seam_improvement_below_threshold");
  }

  if (tonalMixedFailures.length > allowedTonalMixedFailures) {
    failures.push("too_many_tonal_or_mixed_seams");
  }

  if (tonalOnlyFailures.length > 0) {
    failures.push("mechanically_clean_tonal_mismatch");
  }

  if (multiTakeEnabled && improvementPercentage > 0 && tonalMixedFailures.length > 0) {
    failures.push("metrics_improved_but_tonal_mismatch_remains");
  }

  return {
    publishable: failures.length === 0,
    reason: failures.length === 0 ? "passed" : "take_reset",
    killCriteriaFailures: failures,
    thresholds: {
      seamScoreWarning: SEGMENT_SEAM_SCORE_WARNING,
      minimumAverageImprovementPercentage:
        MULTI_TAKE_MINIMUM_AVERAGE_IMPROVEMENT_PERCENTAGE,
      minimumWorstSeamImprovementPercentage:
        MULTI_TAKE_MINIMUM_WORST_SEAM_IMPROVEMENT_PERCENTAGE,
      tonalMixedSeamsPerTenMinutes: MULTI_TAKE_TONAL_MIXED_SEAMS_PER_TEN_MINUTES
    }
  };
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

    if (!boundary.seamPassed) {
      warnings.push({
        code: "seam-quality",
        message: `Boundary ${boundary.boundaryIndex} seam score is ${boundary.seamQualityScore.toFixed(
          2
        )}.`,
        boundaryIndex: boundary.boundaryIndex,
        value: boundary.seamQualityScore,
        threshold: SEGMENT_SEAM_SCORE_WARNING
      });
    }

    if (boundary.speechCutoffRiskBefore || boundary.speechCutoffRiskAfter) {
      warnings.push({
        code: "speech-cutoff-risk",
        message: `Boundary ${boundary.boundaryIndex} has active speech too close to a segment edge.`,
        boundaryIndex: boundary.boundaryIndex
      });
    }

    if (boundary.suddenToneMismatch && boundary.spectralDifferenceScore !== null) {
      warnings.push({
        code: "spectral-mismatch",
        message: `Boundary ${boundary.boundaryIndex} tone proxy delta is ${boundary.spectralDifferenceScore.toFixed(
          2
        )}.`,
        boundaryIndex: boundary.boundaryIndex,
        value: boundary.spectralDifferenceScore,
        threshold: SEGMENT_SPECTRAL_MISMATCH_WARNING
      });
    }

    if (
      (boundary.seamFailureKind === "tonal" || boundary.seamFailureKind === "mixed") &&
      boundary.toneMismatchScore > SEGMENT_TONE_MISMATCH_WARNING
    ) {
      warnings.push({
        code: "tonal-mismatch",
        message: `Boundary ${boundary.boundaryIndex} tonal mismatch score is ${boundary.toneMismatchScore.toFixed(
          2
        )}.`,
        boundaryIndex: boundary.boundaryIndex,
        value: boundary.toneMismatchScore,
        threshold: SEGMENT_TONE_MISMATCH_WARNING
      });
    }

    if (boundary.gapDurationMs > SECTION_JOIN_PAUSE_MS) {
      warnings.push({
        code: "seam-gap",
        message: `Boundary ${boundary.boundaryIndex} join gap is ${boundary.gapDurationMs} ms.`,
        boundaryIndex: boundary.boundaryIndex,
        value: boundary.gapDurationMs,
        threshold: SECTION_JOIN_PAUSE_MS
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

function parseAudioWindowStats(output: string): AudioWindowStats {
  return {
    peakLevelDb: parseLastFiniteMetric(output, /Peak level dB:\s*(-?(?:\d+(?:\.\d+)?|inf))/gi),
    rmsLevelDb: parseLastFiniteMetric(output, /RMS level dB:\s*(-?(?:\d+(?:\.\d+)?|inf))/gi),
    zeroCrossingsRate: parseLastFiniteMetric(
      output,
      /Zero crossings rate:\s*(-?(?:\d+(?:\.\d+)?|inf))/gi
    )
  };
}

function averageEdgeLoudness(
  samples: AudioLoudnessTimelinePoint[],
  durationSeconds: number | null,
  edge: "first" | "last",
  windowSeconds: number
): number | null {
  if (samples.length === 0) {
    return null;
  }

  const selected =
    edge === "first"
      ? samples.filter((sample) => sample.seconds <= windowSeconds)
      : durationSeconds === null
        ? samples.slice(-Math.max(1, windowSeconds))
        : samples.filter((sample) => sample.seconds >= durationSeconds - windowSeconds);

  const usable = selected.length > 0 ? selected : edge === "first" ? samples.slice(0, 1) : samples.slice(-1);
  const total = usable.reduce((sum, sample) => sum + sample.shortTermLufs, 0);
  return roundToTwoDecimals(total / usable.length);
}

function isSpeechCutoffRisk(edgeRmsDb: number | null): boolean {
  return edgeRmsDb !== null && edgeRmsDb > SEGMENT_EDGE_CUTOFF_RMS_WARNING_DB;
}

function computeSpectralDifferenceScore({
  previousZeroCrossingRate,
  nextZeroCrossingRate,
  rmsDeltaDb
}: {
  previousZeroCrossingRate: number | null;
  nextZeroCrossingRate: number | null;
  rmsDeltaDb: number | null;
}): number | null {
  if (previousZeroCrossingRate === null || nextZeroCrossingRate === null) {
    return null;
  }

  const zeroCrossingDelta = Math.abs(nextZeroCrossingRate - previousZeroCrossingRate);
  const rmsContribution = rmsDeltaDb === null ? 0 : Math.min(10, rmsDeltaDb);
  return roundToTwoDecimals(zeroCrossingDelta * 100 + rmsContribution * 0.75);
}

function computeSpeakingRateWps(
  wordCount: number | undefined,
  durationSeconds: number | null
): number | null {
  if (
    wordCount === undefined ||
    durationSeconds === null ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return null;
  }

  return roundToTwoDecimals(wordCount / durationSeconds);
}

function findPairwiseScore(
  boundary: MultiTakePairwiseSeamScoreBoundary | undefined,
  leftCandidateIndex: number,
  rightCandidateIndex: number
): MultiTakePairwiseSeamScore | null {
  return (
    boundary?.scores.find(
      (score) =>
        score.leftCandidateIndex === leftCandidateIndex &&
        score.rightCandidateIndex === rightCandidateIndex
    ) ?? null
  );
}

function findWorstSeamForPath({
  path,
  pairwiseSeamScoreMatrix
}: {
  path: number[];
  pairwiseSeamScoreMatrix: MultiTakePairwiseSeamScoreBoundary[];
}): MultiTakeWorstSeam | null {
  let worst: MultiTakeWorstSeam | null = null;

  for (let segmentIndex = 1; segmentIndex < path.length; segmentIndex += 1) {
    const score = findPairwiseScore(
      pairwiseSeamScoreMatrix[segmentIndex - 1],
      path[segmentIndex - 1] ?? 0,
      path[segmentIndex] ?? 0
    );

    if (!score || (worst !== null && score.score <= worst.score)) {
      continue;
    }

    worst = {
      boundaryIndex: score.boundaryIndex,
      score: score.score,
      seamFailureKind: score.seamFailureKind,
      seamFailureReason: score.seamFailureReason,
      leftCandidateIndex: score.leftCandidateIndex,
      rightCandidateIndex: score.rightCandidateIndex
    };
  }

  return worst;
}

function computeImprovementPercentage(before: number, after: number): number {
  if (before <= 0) {
    return after < before ? 100 : 0;
  }

  return roundToTwoDecimals(((before - after) / before) * 100);
}

function describeSeamFailure({
  seamPassed,
  seamFailureKind,
  deltaLufs,
  rmsDeltaDb,
  gapDurationMs,
  spectralDifferenceScore,
  speakingRateDeltaWps,
  toneMismatchScore,
  edgeToneMismatchScore,
  speechCutoffRiskBefore,
  speechCutoffRiskAfter
}: {
  seamPassed: boolean;
  seamFailureKind: SegmentSeamFailureKind;
  deltaLufs: number | null;
  rmsDeltaDb: number | null;
  gapDurationMs: number;
  spectralDifferenceScore: number | null;
  speakingRateDeltaWps: number | null;
  toneMismatchScore: number;
  edgeToneMismatchScore: number;
  speechCutoffRiskBefore: boolean;
  speechCutoffRiskAfter: boolean;
}): string {
  if (seamPassed) {
    return "passed";
  }

  const reasons: string[] = [];

  if (deltaLufs !== null && deltaLufs > SEGMENT_NEAR_BOUNDARY_JUMP_WARNING_LU) {
    reasons.push(`loudness-delta-${deltaLufs.toFixed(2)}LU`);
  }

  if (rmsDeltaDb !== null && rmsDeltaDb > SEGMENT_RMS_BOUNDARY_WARNING_DB) {
    reasons.push(`rms-delta-${rmsDeltaDb.toFixed(2)}dB`);
  }

  if (gapDurationMs > SECTION_JOIN_PAUSE_MS) {
    reasons.push(`gap-${gapDurationMs}ms`);
  }

  if (speechCutoffRiskBefore || speechCutoffRiskAfter) {
    reasons.push("speech-cutoff-risk");
  }

  if (toneMismatchScore > SEGMENT_TONE_MISMATCH_WARNING) {
    reasons.push(`tone-score-${toneMismatchScore.toFixed(2)}`);
  }

  if (edgeToneMismatchScore > SEGMENT_EDGE_TONE_MISMATCH_WARNING) {
    reasons.push(`edge-tone-${edgeToneMismatchScore.toFixed(2)}`);
  }

  if (
    spectralDifferenceScore !== null &&
    spectralDifferenceScore > SEGMENT_SPECTRAL_MISMATCH_WARNING
  ) {
    reasons.push(`spectral-proxy-${spectralDifferenceScore.toFixed(2)}`);
  }

  if (
    speakingRateDeltaWps !== null &&
    speakingRateDeltaWps > SEGMENT_SPEAKING_RATE_DELTA_WARNING_WPS
  ) {
    reasons.push(`speaking-rate-delta-${speakingRateDeltaWps.toFixed(2)}wps`);
  }

  return `${seamFailureKind}:${reasons.join(",") || "score-threshold"}`;
}

function classifyJoinPause(
  previousText: string,
  nextText: string,
  smoothJoins: boolean
): Pick<SegmentJoinPlan, "pauseMs" | "reason"> {
  if (!smoothJoins) {
    return { pauseMs: 0, reason: "disabled" };
  }

  const previous = previousText.trim();
  const next = nextText.trim();

  if (isSectionLikeBoundary(previous, next)) {
    return { pauseMs: SECTION_JOIN_PAUSE_MS, reason: "section" };
  }

  if (/[.!?]["')\]]?$/.test(previous)) {
    return { pauseMs: PARAGRAPH_JOIN_PAUSE_MS, reason: "paragraph" };
  }

  if (/[,;:]["')\]]?$/.test(previous)) {
    return { pauseMs: SOFT_JOIN_PAUSE_MS, reason: "soft" };
  }

  return { pauseMs: DEFAULT_JOIN_PAUSE_MS, reason: "sentence" };
}

function isSectionLikeBoundary(previousText: string, nextText: string): boolean {
  const lastLine = previousText.split(/\n+/).map((part) => part.trim()).filter(Boolean).at(-1) ?? "";
  const firstLine = nextText.split(/\n+/).map((part) => part.trim()).filter(Boolean)[0] ?? "";

  return isHeadingLikeAudioBoundary(lastLine) || isHeadingLikeAudioBoundary(firstLine);
}

function isHeadingLikeAudioBoundary(text: string): boolean {
  if (!text || text.length > 90 || /[.!?,;:]$/.test(text)) {
    return false;
  }

  const wordCount = text.match(/\b[\p{L}\p{N}'’-]+\b/gu)?.length ?? 0;
  return wordCount > 0 && wordCount <= 10 && /^[A-Z0-9][\w'".,:;!? -]+$/.test(text);
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

function parseLastFiniteMetric(output: string, pattern: RegExp): number | null {
  const matches = [...output.matchAll(pattern)];

  for (const match of matches.reverse()) {
    const parsed = parseFiniteNumber(match[1]);

    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
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

function roundToThreeDecimals(value: number): number {
  return Number(value.toFixed(3));
}

function nullEdgeToneBandMetrics(): EdgeToneBandMetrics {
  return {
    lowDb: null,
    midDb: null,
    highDb: null
  };
}

function computeNullableAbsDelta(previous: number | null, next: number | null): number | null {
  if (previous === null || next === null) {
    return null;
  }

  return roundToTwoDecimals(Math.abs(next - previous));
}

function computePositiveDelta(next: number | null, previous: number | null): number | null {
  if (next === null || previous === null) {
    return null;
  }

  return roundToTwoDecimals(Math.max(0, next - previous));
}

function averageNullableNumbers(values: Array<number | null>): number | null {
  const finiteValues = values.filter((value): value is number => value !== null && Number.isFinite(value));

  if (finiteValues.length === 0) {
    return null;
  }

  return roundToTwoDecimals(
    finiteValues.reduce((total, value) => total + value, 0) / finiteValues.length
  );
}

function edgeToneBandFilter(lowFrequency: number, highFrequency: number): string {
  return `highpass=f=${lowFrequency},lowpass=f=${highFrequency},astats=metadata=0:reset=0`;
}

function scoreAcousticTrimCandidate(
  candidate: Omit<AcousticTrimSearchCandidate, "score" | "selected">
): number {
  const combinedRmsDb = candidate.combinedRmsDb ?? -20;
  const afterRmsDb = candidate.afterRmsDb ?? -20;
  const beforeRmsDb = candidate.beforeRmsDb ?? -20;
  const offsetMagnitude = Math.abs(candidate.offsetSeconds);
  const speechOnsetPenalty = Math.max(0, afterRmsDb + 30) * 0.9;
  const cutoffPenalty = Math.max(0, beforeRmsDb + 24) * 0.35;
  const lateCutPenalty = Math.max(0, candidate.offsetSeconds - 0.22) * 10;
  const earlyDuplicatePenalty = Math.max(0, -candidate.offsetSeconds - 0.22) * 4;

  return roundToTwoDecimals(
    combinedRmsDb +
      offsetMagnitude * 2.5 +
      speechOnsetPenalty +
      cutoffPenalty +
      lateCutPenalty +
      earlyDuplicatePenalty
  );
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
