import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_VOICE_LAB_DATA_DIR_NAME = ".voice-lab";
export const DEFAULT_VOICE_REFERENCE_ID = "default";

export type VoiceReferenceStoragePaths = {
  directoryPath: string;
  referenceAudioPath: string;
  transcriptPath: string;
  metadataPath: string;
};

export type VoiceLabRunStoragePaths = {
  runDirectoryPath: string;
  segmentsDirectoryPath: string;
  finalDirectoryPath: string;
  manifestPath: string;
};

export function resolveVoiceLabDataDir(): string {
  const configured = process.env.VOICE_LAB_DATA_DIR?.trim();
  return configured
    ? path.resolve(/*turbopackIgnore: true*/ configured)
    : path.join(homedir(), DEFAULT_VOICE_LAB_DATA_DIR_NAME);
}

export function getVoiceReferenceStoragePaths({
  dataDir = resolveVoiceLabDataDir(),
  referenceId = DEFAULT_VOICE_REFERENCE_ID
}: {
  dataDir?: string;
  referenceId?: string;
} = {}): VoiceReferenceStoragePaths {
  const safeReferenceId = sanitizeStorageId(referenceId, DEFAULT_VOICE_REFERENCE_ID);
  const directoryPath = resolveStoragePath(dataDir, "references", safeReferenceId);

  return {
    directoryPath,
    referenceAudioPath: resolveStoragePath(directoryPath, "reference.wav"),
    transcriptPath: resolveStoragePath(directoryPath, "transcript.txt"),
    metadataPath: resolveStoragePath(directoryPath, "metadata.json")
  };
}

export function getVoiceLabRunStoragePaths({
  dataDir = resolveVoiceLabDataDir(),
  runId
}: {
  dataDir?: string;
  runId: string;
}): VoiceLabRunStoragePaths {
  const safeRunId = sanitizeStorageId(runId, "run");
  const runDirectoryPath = resolveStoragePath(dataDir, "runs", safeRunId);
  const segmentsDirectoryPath = resolveStoragePath(runDirectoryPath, "segments");
  const finalDirectoryPath = resolveStoragePath(runDirectoryPath, "final");

  return {
    runDirectoryPath,
    segmentsDirectoryPath,
    finalDirectoryPath,
    manifestPath: resolveStoragePath(runDirectoryPath, "manifest.json")
  };
}

export function resolveUploadTempDirectoryPath({
  dataDir = resolveVoiceLabDataDir(),
  directoryName
}: {
  dataDir?: string;
  directoryName: string;
}): string {
  return resolveStoragePath(dataDir, "tmp", sanitizeStorageId(directoryName, "upload"));
}

export function resolveStoragePath(rootPath: string, ...segments: string[]): string {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(root, ...segments);

  if (!isPathInside(root, candidate)) {
    throw new Error("Storage path escapes VOICE_LAB_DATA_DIR.");
  }

  return candidate;
}

export function sanitizeStorageId(input: string, fallback: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/[._-]{2,}/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 96);

  return normalized || fallback;
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
