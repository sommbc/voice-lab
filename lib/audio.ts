import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type OutputFormat = "mp3" | "wav";
export type VolumeBoost = "normal" | "louder" | "very-loud";
export type AudioProcessingStage =
  | "availability-check"
  | "segment-normalization"
  | "merge"
  | "join-smoothing"
  | "final-normalization"
  | "measurement"
  | "encoding";

type MergeStrategy = "copy" | "reencode";
type LoudnessSettings = {
  integratedLoudness: number;
  truePeak: number;
  limiter: number;
  maxCorrectionGainDb: number;
  targetToleranceLufs: number;
};

export type AudioLoudnessMetrics = {
  integratedLoudness: number | null;
  truePeak: number | null;
  maxVolume: number | null;
  measurementMode: "loudnorm" | "volumedetect";
};

export type AudioMasteringResult = {
  attempts: number;
  correctionGainDb: number;
  metrics: AudioLoudnessMetrics | null;
};

export const DEFAULT_OUTPUT_FORMAT: OutputFormat = "mp3";
export const DEFAULT_VOLUME_BOOST: VolumeBoost = "louder";
export const DEFAULT_SMOOTH_JOINS = true;
export const DEFAULT_JOIN_PAUSE_MS = 300;
export const STANDARD_INTERMEDIATE_SAMPLE_RATE = 24_000;
export const STANDARD_INTERMEDIATE_CHANNELS = 1;
export const TRIM_SILENCE_FILTER =
  "silenceremove=start_periods=1:start_duration=0.02:start_threshold=-45dB:start_silence=0.04:detection=rms,areverse,silenceremove=start_periods=1:start_duration=0.02:start_threshold=-45dB:start_silence=0.08:detection=rms,areverse";
export const LOUDNORM_FILTER =
  "loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=0.841:level=disabled";
export const FFMPEG_MISSING_MESSAGE =
  "ffmpeg executable not found. Checked FFMPEG_PATH, bundled ffmpeg-static, and system ffmpeg on PATH.";

const MP3_BITRATE = "192k";
const FFMPEG_TIMEOUT_MS = 180_000;
const LOUDNESS_MEASUREMENT_FILTER = "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json";
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
    limiter: getLimiterLimit(-1.5),
    maxCorrectionGainDb: 2.5,
    targetToleranceLufs: 0.35
  },
  louder: {
    integratedLoudness: -14,
    truePeak: -1,
    limiter: getLimiterLimit(-1),
    maxCorrectionGainDb: 3.5,
    targetToleranceLufs: 0.35
  },
  "very-loud": {
    integratedLoudness: -12.5,
    truePeak: -0.8,
    limiter: getLimiterLimit(-0.8),
    maxCorrectionGainDb: 4,
    targetToleranceLufs: 0.4
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
  volumeBoost
}: {
  inputPath: string;
  outputPath: string;
  outputFormat: OutputFormat;
  volumeBoost: VolumeBoost;
}): Promise<AudioMasteringResult> {
  await assertAudioFileReady(inputPath);

  const settings = VOLUME_BOOST_SETTINGS[volumeBoost];
  const outputExtension = getFileExtension(outputFormat);
  const outputDirectory = path.dirname(outputPath);
  let correctionGainDb = 0;
  let bestCandidate:
    | {
        path: string;
        metrics: AudioLoudnessMetrics | null;
        score: number;
        attempts: number;
        correctionGainDb: number;
      }
    | null = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const candidatePath = path.join(outputDirectory, `final-output-attempt-${attempt}.${outputExtension}`);

    await transcodeAudioFile({
      inputPath,
      outputPath: candidatePath,
      outputFormat,
      applyLoudnorm: true,
      volumeBoost,
      masteringCorrectionDb: correctionGainDb,
      stage: "final-normalization"
    });

    const metrics = await measureAudioFile(candidatePath).catch((error) => {
      console.warn(
        "[mastering] measurement unavailable",
        JSON.stringify({
          attempt,
          outputPath: candidatePath,
          reason: error instanceof Error ? error.message : "Unknown measurement failure."
        })
      );
      return null;
    });
    const score = getMasteringScore(metrics, settings);

    console.info(
      "[mastering] attempt",
      JSON.stringify({
        attempt,
        volumeBoost,
        correctionGainDb: Number(correctionGainDb.toFixed(2)),
        measuredIntegratedLoudness: metrics?.integratedLoudness ?? null,
        measuredTruePeak: metrics?.truePeak ?? null,
        measuredMaxVolume: metrics?.maxVolume ?? null,
        score
      })
    );

    if (!bestCandidate || score < bestCandidate.score) {
      bestCandidate = {
        path: candidatePath,
        metrics,
        score,
        attempts: attempt,
        correctionGainDb
      };
    }

    if (isWithinMasteringTarget(metrics, settings)) {
      break;
    }

    const nextCorrection = calculateMasteringCorrectionDb(metrics, settings);

    if (nextCorrection === 0) {
      break;
    }

    correctionGainDb = clamp(
      correctionGainDb + nextCorrection,
      -settings.maxCorrectionGainDb,
      settings.maxCorrectionGainDb
    );
  }

  if (!bestCandidate) {
    throw new Error("Mastering failed before any output candidate was created.");
  }

  await rename(bestCandidate.path, outputPath);
  await rmAttemptFiles(outputDirectory, outputPath);
  await assertAudioFileReady(outputPath);

  return {
    attempts: bestCandidate.attempts,
    correctionGainDb: Number(bestCandidate.correctionGainDb.toFixed(2)),
    metrics: bestCandidate.metrics
  };
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

function parseLoudnormMetrics(output: string): AudioLoudnessMetrics | null {
  const match = output.match(/\{\s*"input_i"[\s\S]*?\}/);

  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[0]) as {
      input_i?: string;
      input_tp?: string;
    };

    return {
      integratedLoudness: parseFiniteNumber(parsed.input_i),
      truePeak: parseFiniteNumber(parsed.input_tp),
      maxVolume: null,
      measurementMode: "loudnorm"
    };
  } catch {
    return null;
  }
}

function parseMaxVolume(output: string): number | null {
  const match = output.match(/max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i);
  return parseFiniteNumber(match?.[1]);
}

function parseFiniteNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function calculateMasteringCorrectionDb(
  metrics: AudioLoudnessMetrics | null,
  settings: LoudnessSettings
): number {
  if (metrics?.integratedLoudness === null || metrics?.integratedLoudness === undefined) {
    return 0;
  }

  const delta = settings.integratedLoudness - metrics.integratedLoudness;

  if (Math.abs(delta) < 0.15) {
    return 0;
  }

  return clamp(delta, -2.5, 3);
}

function isWithinMasteringTarget(
  metrics: AudioLoudnessMetrics | null,
  settings: LoudnessSettings
): boolean {
  if (metrics?.integratedLoudness === null || metrics?.integratedLoudness === undefined) {
    return false;
  }

  const loudnessOk =
    Math.abs(metrics.integratedLoudness - settings.integratedLoudness) <= settings.targetToleranceLufs;
  const peakMeasurement = metrics.truePeak ?? metrics.maxVolume;
  const peakOk = peakMeasurement === null || peakMeasurement <= settings.truePeak + 0.15;

  return loudnessOk && peakOk;
}

function getMasteringScore(
  metrics: AudioLoudnessMetrics | null,
  settings: LoudnessSettings
): number {
  if (metrics?.integratedLoudness === null || metrics?.integratedLoudness === undefined) {
    return Number.POSITIVE_INFINITY;
  }

  const loudnessDistance = Math.abs(metrics.integratedLoudness - settings.integratedLoudness);
  const peakMeasurement = metrics.truePeak ?? metrics.maxVolume;
  const peakOverflow =
    peakMeasurement === null ? 0 : Math.max(0, peakMeasurement - settings.truePeak);

  return Number((loudnessDistance + peakOverflow * 2).toFixed(3));
}

async function rmAttemptFiles(outputDirectory: string, preservedPath: string): Promise<void> {
  const preservedBasename = path.basename(preservedPath);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const attemptPath = path.join(
      outputDirectory,
      `final-output-attempt-${attempt}.${path.extname(preservedPath).slice(1)}`
    );

    if (path.basename(attemptPath) === preservedBasename) {
      continue;
    }

    await rm(attemptPath, { force: true });
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
