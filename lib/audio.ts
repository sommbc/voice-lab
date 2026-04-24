import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";

export type OutputFormat = "mp3" | "wav";

export const DEFAULT_OUTPUT_FORMAT: OutputFormat = "mp3";
export const LOUDNORM_FILTER = "loudnorm=I=-16:TP=-1.5:LRA=11";
export const FFMPEG_MISSING_MESSAGE =
  "ffmpeg is required for narration segmentation and normalization, but no usable binary was found. Install ffmpeg locally (`brew install ffmpeg`) or set FFMPEG_PATH.";

const MP3_BITRATE = "192k";
const FFMPEG_CANDIDATES = [
  process.env.FFMPEG_PATH?.trim(),
  ffmpegStatic ?? undefined,
  "ffmpeg"
].filter((value): value is string => Boolean(value));

let ffmpegExecutablePromise: Promise<string> | null = null;

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
  applyLoudnorm
}: {
  inputPath: string;
  outputPath: string;
  outputFormat: OutputFormat;
  applyLoudnorm: boolean;
}): Promise<void> {
  await runFfmpeg(
    buildTranscodeArgs({
      inputPath,
      outputPath,
      outputFormat,
      applyLoudnorm
    }),
    applyLoudnorm ? "normalizing audio" : "encoding audio"
  );

  const outputStats = await stat(outputPath);
  if (outputStats.size === 0) {
    throw new Error("ffmpeg created an empty audio file.");
  }
}

export async function mergeAudioFiles({
  inputPaths,
  outputPath,
  copyAudio
}: {
  inputPaths: string[];
  outputPath: string;
  copyAudio: boolean;
}): Promise<void> {
  const listFilePath = path.join(path.dirname(outputPath), `concat-${randomUUID()}.txt`);
  const concatList = inputPaths
    .map((inputPath) => `file '${escapeForFfmpegConcat(inputPath)}'`)
    .join("\n");

  await writeFile(listFilePath, concatList);

  try {
    await runFfmpeg(
      buildMergeArgs({
        listFilePath,
        outputPath,
        copyAudio
      }),
      "merging audio"
    );

    const outputStats = await stat(outputPath);
    if (outputStats.size === 0) {
      throw new Error("ffmpeg created an empty merged audio file.");
    }
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
  copyAudio
}: {
  listFilePath: string;
  outputPath: string;
  copyAudio: boolean;
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
    ...(copyAudio ? ["-c", "copy"] : ["-c:a", "pcm_s16le"]),
    outputPath
  ];
}

async function runFfmpeg(argumentsList: string[], action: string): Promise<void> {
  const ffmpegExecutable = await getFfmpegExecutable();

  await new Promise<void>((resolve, reject) => {
    const ffmpegProcess = spawn(ffmpegExecutable, argumentsList, {
      stdio: ["ignore", "ignore", "pipe"]
    });

    let stderr = "";

    ffmpegProcess.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    ffmpegProcess.once("error", () => {
      reject(new Error(FFMPEG_MISSING_MESSAGE));
    });

    ffmpegProcess.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg failed while ${action}. ${truncate(stderr, 500)}`));
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
    const process = spawn(executable, ["-version"]);

    process.once("error", () => {
      resolve(false);
    });

    process.once("exit", (code) => {
      resolve(code === 0);
    });
  });
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

function truncate(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength)}...`;
}
