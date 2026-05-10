import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { transcodeAudioFile } from "./audio";
import {
  DEFAULT_VOICE_REFERENCE_ID,
  getVoiceLabRunStoragePaths,
  getVoiceReferenceStoragePaths,
  resolveUploadTempDirectoryPath,
  resolveVoiceLabDataDir
} from "./storage";

export { resolveVoiceLabDataDir };

export type VoiceReferenceMetadata = {
  id: string;
  updatedAt: string;
  referenceFilename: string;
  transcriptFilename: string;
  audioSha256: string;
  transcriptSha256: string;
  audioBytes: number;
  transcriptCharacters: number;
};

export type VoiceReference = {
  metadata: VoiceReferenceMetadata;
  referenceAudioPath: string;
  transcriptPath: string;
  transcript: string;
};

export type VoiceReferenceClientMetadata = {
  id: string;
  updatedAt: string;
  referenceFilename: string;
  transcriptFilename: string;
  audioSha256: string;
  transcriptSha256: string;
  audioBytes: number;
  transcriptCharacters: number;
};

export type VoiceLabRunWorkspace = {
  runId: string;
  runDirectoryPath: string;
  segmentsDirectoryPath: string;
  finalDirectoryPath: string;
  manifestPath: string;
};

export function validateReferenceTranscript(transcript: string): string {
  const cleaned = transcript.replace(/\s+/g, " ").trim();

  if (!cleaned) {
    throw new Error("Reference transcript is required.");
  }

  if (cleaned.length < 20) {
    throw new Error("Reference transcript is too short to align with the reference audio.");
  }

  return cleaned;
}

export async function saveVoiceReference({
  sourceAudioPath,
  transcript,
  dataDir = resolveVoiceLabDataDir()
}: {
  sourceAudioPath: string;
  transcript: string;
  dataDir?: string;
}): Promise<VoiceReference> {
  const cleanedTranscript = validateReferenceTranscript(transcript);
  const paths = getVoiceReferenceStoragePaths({ dataDir });
  const tempPath = path.join(paths.directoryPath, `reference-${randomUUID()}.wav`);

  await mkdir(paths.directoryPath, { recursive: true });
  await transcodeAudioFile({
    inputPath: sourceAudioPath,
    outputPath: tempPath,
    outputFormat: "wav",
    applyLoudnorm: false,
    stage: "encoding",
    sampleRate: 16000,
    channels: 1
  });
  await rename(tempPath, paths.referenceAudioPath);
  await writeFile(paths.transcriptPath, `${cleanedTranscript}\n`, "utf8");

  const [audioBuffer, audioStats] = await Promise.all([
    readFile(paths.referenceAudioPath),
    stat(paths.referenceAudioPath)
  ]);
  const transcriptBuffer = Buffer.from(cleanedTranscript, "utf8");
  const metadata: VoiceReferenceMetadata = {
    id: DEFAULT_VOICE_REFERENCE_ID,
    updatedAt: new Date().toISOString(),
    referenceFilename: path.basename(paths.referenceAudioPath),
    transcriptFilename: path.basename(paths.transcriptPath),
    audioSha256: sha256(audioBuffer),
    transcriptSha256: sha256(transcriptBuffer),
    audioBytes: audioStats.size,
    transcriptCharacters: cleanedTranscript.length
  };

  await writeFile(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  return {
    metadata,
    referenceAudioPath: paths.referenceAudioPath,
    transcriptPath: paths.transcriptPath,
    transcript: cleanedTranscript
  };
}

export async function loadVoiceReference(
  dataDir = resolveVoiceLabDataDir()
): Promise<VoiceReference | null> {
  const paths = getVoiceReferenceStoragePaths({ dataDir });

  try {
    const [metadataRaw, transcriptRaw] = await Promise.all([
      readFile(paths.metadataPath, "utf8"),
      readFile(paths.transcriptPath, "utf8"),
      stat(paths.referenceAudioPath)
    ]);
    const metadata = JSON.parse(metadataRaw) as VoiceReferenceMetadata;
    const transcript = validateReferenceTranscript(transcriptRaw);

    return {
      metadata,
      referenceAudioPath: paths.referenceAudioPath,
      transcriptPath: paths.transcriptPath,
      transcript
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

export async function createVoiceLabRunWorkspace(
  dataDir = resolveVoiceLabDataDir()
): Promise<VoiceLabRunWorkspace> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runId = `${timestamp}-${randomUUID().slice(0, 8)}`;
  const paths = getVoiceLabRunStoragePaths({ dataDir, runId });

  await mkdir(paths.segmentsDirectoryPath, { recursive: true });
  await mkdir(paths.finalDirectoryPath, { recursive: true });

  return {
    runId,
    ...paths
  };
}

export async function createUploadTempDirectory(
  dataDir = resolveVoiceLabDataDir()
): Promise<string> {
  const directoryPath = resolveUploadTempDirectoryPath({
    dataDir,
    directoryName: `upload-${randomUUID()}`
  });
  await mkdir(directoryPath, { recursive: true });
  return directoryPath;
}

export async function removePrivateTempDirectory(directoryPath: string): Promise<void> {
  if (!directoryPath) {
    return;
  }

  await rm(directoryPath, { force: true, recursive: true });
}

export function toClientVoiceReferenceMetadata(
  metadata: VoiceReferenceMetadata
): VoiceReferenceClientMetadata {
  return {
    id: metadata.id,
    updatedAt: metadata.updatedAt,
    referenceFilename: metadata.referenceFilename,
    transcriptFilename: metadata.transcriptFilename,
    audioSha256: metadata.audioSha256,
    transcriptSha256: metadata.transcriptSha256,
    audioBytes: metadata.audioBytes,
    transcriptCharacters: metadata.transcriptCharacters
  };
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
