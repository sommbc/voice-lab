import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type OutputFormat = "mp3" | "wav";
export type AudioProcessingStage =
  | "availability-check"
  | "segment-normalization"
  | "merge"
  | "final-normalization"
  | "encoding";

type MergeStrategy = "copy" | "reencode";

export const DEFAULT_OUTPUT_FORMAT: OutputFormat = "mp3";
export const LOUDNORM_FILTER = "loudnorm=I=-16:TP=-1.5:LRA=11";
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
  stage
}: {
  inputPath: string;
  outputPath: string;
  outputFormat: OutputFormat;
  applyLoudnorm: boolean;
  stage?: AudioProcessingStage;
}): Promise<void> {
  await assertAudioFileReady(inputPath);

  await runFfmpeg(
    buildTranscodeArgs({
      inputPath,
      outputPath,
      outputFormat,
      applyLoudnorm
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

export function buildTranscodeArgs({
  inputPath,
  outputPath,
  outputFormat,
  applyLoudnorm
}: {
  inputPath: string;
  outputPath: string;
  outputFormat: OutputFormat;
  applyLoudnorm: boolean;
}): string[] {
  const args = ["-y", "-i", inputPath, "-vn"];

  if (applyLoudnorm) {
    args.push("-af", LOUDNORM_FILTER);
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

function getCodecArgs(outputFormat: OutputFormat): string[] {
  if (outputFormat === "wav") {
    return ["-c:a", "pcm_s16le"];
  }

  return ["-c:a", "libmp3lame", "-b:a", MP3_BITRATE];
}

function escapeForFfmpegConcat(filePath: string): string {
  return filePath.replace(/'/g, "'\\''");
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
