import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type OutputFormat = "mp3" | "wav";
export type VolumeBoost = "normal" | "louder" | "very-loud";
export type AudioProcessingStage =
  | "availability-check"
  | "segment-normalization"
  | "merge"
  | "join-smoothing"
  | "final-normalization"
  | "encoding";

type MergeStrategy = "copy" | "reencode";
type LoudnessSettings = {
  integratedLoudness: number;
  truePeak: number;
  limiter: number;
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
const VOLUME_BOOST_SETTINGS: Record<VolumeBoost, LoudnessSettings> = {
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

export async function transcodeAudioFile({
  inputPath,
  outputPath,
  outputFormat,
  applyLoudnorm,
  stage,
  volumeBoost = DEFAULT_VOLUME_BOOST,
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

export function buildTranscodeArgs({
  inputPath,
  outputPath,
  outputFormat,
  applyLoudnorm,
  volumeBoost = DEFAULT_VOLUME_BOOST,
  trimSilence = false,
  sampleRate,
  channels
}: {
  inputPath: string;
  outputPath: string;
  outputFormat: OutputFormat;
  applyLoudnorm: boolean;
  volumeBoost?: VolumeBoost;
  trimSilence?: boolean;
  sampleRate?: number;
  channels?: number;
}): string[] {
  const args = ["-y", "-i", inputPath, "-vn"];
  const audioFilterChain = buildAudioFilterChain({
    applyLoudnorm,
    volumeBoost,
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

export function buildMasteringFilter(volumeBoost: VolumeBoost): string {
  const settings = VOLUME_BOOST_SETTINGS[volumeBoost];
  return `loudnorm=I=${settings.integratedLoudness}:TP=${settings.truePeak}:LRA=11,alimiter=limit=${settings.limiter}:level=disabled`;
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

  await new Promise<void>((resolve, reject) => {
    const ffmpegProcess = spawn(ffmpegExecutable, argumentsList, {
      stdio: ["ignore", "ignore", "pipe"]
    });

    let stderr = "";
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      ffmpegProcess.kill("SIGKILL");
    }, FFMPEG_TIMEOUT_MS);

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
        resolve();
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
  trimSilence
}: {
  applyLoudnorm: boolean;
  volumeBoost: VolumeBoost;
  trimSilence: boolean;
}): string | null {
  const filters: string[] = [];

  if (trimSilence) {
    filters.push(TRIM_SILENCE_FILTER);
  }

  if (applyLoudnorm) {
    filters.push(buildMasteringFilter(volumeBoost));
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
