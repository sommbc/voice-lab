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

export const CANONICAL_REFERENCE_SAMPLE_RATE = 48_000;
export const CANONICAL_REFERENCE_CHANNELS = 1;
export const CANONICAL_REFERENCE_FILENAME = "reference.wav";
export const REFERENCE_TRANSCRIPT_FILENAME = "transcript.txt";
export const REFERENCE_METADATA_FILENAME = "metadata.json";
export const REFERENCE_AUDIO_TRY_MESSAGE = "Try MP3, M4A, WAV, WebM, or OGG.";
export const SUPPORTED_REFERENCE_AUDIO_EXTENSIONS = [
  ".wav",
  ".mp3",
  ".m4a",
  ".mp4",
  ".webm",
  ".ogg",
  ".flac"
] as const;

type SupportedReferenceAudioExtension = (typeof SUPPORTED_REFERENCE_AUDIO_EXTENSIONS)[number];
type TranscodeAudioFile = typeof transcodeAudioFile;

export type VoiceReferenceMetadata = {
  id: string;
  updatedAt: string;
  originalFilename: string;
  originalMimeType: string;
  originalByteSize: number;
  savedCanonicalFilename: string;
  referenceFilename: string;
  transcriptFilename: string;
  audioSha256: string;
  transcriptSha256: string;
  audioBytes: number;
  transcriptCharacters: number;
  canonicalSampleRate: number;
  canonicalChannels: number;
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

export type VoiceReferencePrepareResult = {
  action: "ready" | "metadata-written" | "transcoded" | "missing-transcript" | "missing-audio";
  message: string;
  reference: VoiceReference | null;
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
  dataDir = resolveVoiceLabDataDir(),
  originalFilename,
  originalMimeType,
  originalByteSize,
  transcodeAudio = transcodeAudioFile
}: {
  sourceAudioPath: string;
  transcript: string;
  dataDir?: string;
  originalFilename?: string;
  originalMimeType?: string;
  originalByteSize?: number;
  transcodeAudio?: TranscodeAudioFile;
}): Promise<VoiceReference> {
  const cleanedTranscript = validateReferenceTranscript(transcript);
  const paths = getVoiceReferenceStoragePaths({ dataDir });
  const tempPath = path.join(paths.directoryPath, `reference-${randomUUID()}.wav`);

  await mkdir(paths.directoryPath, { recursive: true });
  try {
    await transcodeAudio({
      inputPath: sourceAudioPath,
      outputPath: tempPath,
      outputFormat: "wav",
      applyLoudnorm: false,
      stage: "encoding",
      sampleRate: CANONICAL_REFERENCE_SAMPLE_RATE,
      channels: CANONICAL_REFERENCE_CHANNELS,
      validateInputContainer: false
    });
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  await rename(tempPath, paths.referenceAudioPath);
  await writeFile(paths.transcriptPath, `${cleanedTranscript}\n`, "utf8");

  const sourceStats = originalByteSize === undefined ? await stat(sourceAudioPath) : null;
  const metadata = await writeVoiceReferenceMetadata({
    paths,
    transcript: cleanedTranscript,
    originalFilename: originalFilename ?? path.basename(sourceAudioPath),
    originalMimeType: originalMimeType ?? inferReferenceMimeType(sourceAudioPath),
    originalByteSize: originalByteSize ?? sourceStats?.size ?? 0
  });

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
    await prepareVoiceReferenceFromLocalFolder({ dataDir });
    return await readVoiceReferenceFromPaths(paths);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

export async function prepareVoiceReferenceFromLocalFolder({
  dataDir = resolveVoiceLabDataDir(),
  transcodeAudio = transcodeAudioFile
}: {
  dataDir?: string;
  transcodeAudio?: TranscodeAudioFile;
} = {}): Promise<VoiceReferencePrepareResult> {
  const paths = getVoiceReferenceStoragePaths({ dataDir });
  const transcriptRaw = await readOptionalTextFile(paths.transcriptPath);

  if (transcriptRaw === null) {
    return {
      action: "missing-transcript",
      message: `Missing ${REFERENCE_TRANSCRIPT_FILENAME} in ${path.join("references", DEFAULT_VOICE_REFERENCE_ID)}.`,
      reference: null
    };
  }

  const transcript = validateReferenceTranscript(transcriptRaw);
  await mkdir(paths.directoryPath, { recursive: true });

  if (await fileExists(paths.referenceAudioPath)) {
    if (!(await fileExists(paths.metadataPath))) {
      const canonicalStats = await stat(paths.referenceAudioPath);
      const metadata = await writeVoiceReferenceMetadata({
        paths,
        transcript,
        originalFilename: CANONICAL_REFERENCE_FILENAME,
        originalMimeType: "audio/wav",
        originalByteSize: canonicalStats.size
      });

      return {
        action: "metadata-written",
        message: "Saved voice reference ready.",
        reference: {
          metadata,
          referenceAudioPath: paths.referenceAudioPath,
          transcriptPath: paths.transcriptPath,
          transcript
        }
      };
    }

    return {
      action: "ready",
      message: "Saved voice reference ready.",
      reference: await readVoiceReferenceFromPaths(paths)
    };
  }

  const source = await findLocalReferenceAudio(paths.directoryPath);

  if (!source) {
    return {
      action: "missing-audio",
      message: `Missing reference audio in ${path.join("references", DEFAULT_VOICE_REFERENCE_ID)}. Expected reference.wav, reference.mp3, reference.m4a, reference.webm, reference.ogg, or reference.flac.`,
      reference: null
    };
  }

  const reference = await saveVoiceReference({
    sourceAudioPath: source.path,
    transcript,
    dataDir,
    originalFilename: source.filename,
    originalMimeType: inferReferenceMimeType(source.filename),
    originalByteSize: source.byteSize,
    transcodeAudio
  });

  return {
    action: "transcoded",
    message: "Saved voice reference ready.",
    reference
  };
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
    referenceFilename: metadata.savedCanonicalFilename || metadata.referenceFilename,
    transcriptFilename: metadata.transcriptFilename,
    audioSha256: metadata.audioSha256,
    transcriptSha256: metadata.transcriptSha256,
    audioBytes: metadata.audioBytes,
    transcriptCharacters: metadata.transcriptCharacters
  };
}

export function formatVoiceReferenceSaveError(error: unknown, originalFilename?: string): string {
  const message = error instanceof Error ? error.message : "Reference audio could not be saved.";

  if (/^Reference transcript /i.test(message) || message === "Reference transcript is required.") {
    return message;
  }

  if (/ffmpeg executable not found/i.test(message)) {
    return "Could not convert this audio file because ffmpeg is not available.";
  }

  const filename = sanitizeMetadataFilename(originalFilename ?? extractFilenameFromMessage(message));
  return `Could not read this audio file${filename ? `: ${filename}` : ""}. ${REFERENCE_AUDIO_TRY_MESSAGE}`;
}

async function readVoiceReferenceFromPaths(
  paths: ReturnType<typeof getVoiceReferenceStoragePaths>
): Promise<VoiceReference> {
  const [metadataRaw, transcriptRaw, audioStats] = await Promise.all([
    readFile(paths.metadataPath, "utf8"),
    readFile(paths.transcriptPath, "utf8"),
    stat(paths.referenceAudioPath)
  ]);
  const transcript = validateReferenceTranscript(transcriptRaw);
  const metadata = normalizeVoiceReferenceMetadata({
    metadata: JSON.parse(metadataRaw) as Partial<VoiceReferenceMetadata>,
    paths,
    audioBytes: audioStats.size,
    transcript
  });

  return {
    metadata,
    referenceAudioPath: paths.referenceAudioPath,
    transcriptPath: paths.transcriptPath,
    transcript
  };
}

async function writeVoiceReferenceMetadata({
  paths,
  transcript,
  originalFilename,
  originalMimeType,
  originalByteSize
}: {
  paths: ReturnType<typeof getVoiceReferenceStoragePaths>;
  transcript: string;
  originalFilename: string;
  originalMimeType: string;
  originalByteSize: number;
}): Promise<VoiceReferenceMetadata> {
  const [audioBuffer, audioStats] = await Promise.all([
    readFile(paths.referenceAudioPath),
    stat(paths.referenceAudioPath)
  ]);
  const transcriptBuffer = Buffer.from(transcript, "utf8");
  const metadata: VoiceReferenceMetadata = {
    id: DEFAULT_VOICE_REFERENCE_ID,
    updatedAt: new Date().toISOString(),
    originalFilename: sanitizeMetadataFilename(originalFilename) || CANONICAL_REFERENCE_FILENAME,
    originalMimeType: originalMimeType.trim() || "application/octet-stream",
    originalByteSize,
    savedCanonicalFilename: CANONICAL_REFERENCE_FILENAME,
    referenceFilename: CANONICAL_REFERENCE_FILENAME,
    transcriptFilename: REFERENCE_TRANSCRIPT_FILENAME,
    audioSha256: sha256(audioBuffer),
    transcriptSha256: sha256(transcriptBuffer),
    audioBytes: audioStats.size,
    transcriptCharacters: transcript.length,
    canonicalSampleRate: CANONICAL_REFERENCE_SAMPLE_RATE,
    canonicalChannels: CANONICAL_REFERENCE_CHANNELS
  };

  await writeFile(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return metadata;
}

function normalizeVoiceReferenceMetadata({
  metadata,
  paths,
  audioBytes,
  transcript
}: {
  metadata: Partial<VoiceReferenceMetadata>;
  paths: ReturnType<typeof getVoiceReferenceStoragePaths>;
  audioBytes: number;
  transcript: string;
}): VoiceReferenceMetadata {
  return {
    id: metadata.id || DEFAULT_VOICE_REFERENCE_ID,
    updatedAt: metadata.updatedAt || new Date(0).toISOString(),
    originalFilename:
      sanitizeMetadataFilename(metadata.originalFilename) || path.basename(paths.referenceAudioPath),
    originalMimeType: metadata.originalMimeType || "audio/wav",
    originalByteSize: metadata.originalByteSize ?? audioBytes,
    savedCanonicalFilename: metadata.savedCanonicalFilename || CANONICAL_REFERENCE_FILENAME,
    referenceFilename: metadata.referenceFilename || CANONICAL_REFERENCE_FILENAME,
    transcriptFilename: metadata.transcriptFilename || REFERENCE_TRANSCRIPT_FILENAME,
    audioSha256: metadata.audioSha256 || "",
    transcriptSha256: metadata.transcriptSha256 || sha256(Buffer.from(transcript, "utf8")),
    audioBytes: metadata.audioBytes ?? audioBytes,
    transcriptCharacters: metadata.transcriptCharacters ?? transcript.length,
    canonicalSampleRate: metadata.canonicalSampleRate ?? CANONICAL_REFERENCE_SAMPLE_RATE,
    canonicalChannels: metadata.canonicalChannels ?? CANONICAL_REFERENCE_CHANNELS
  };
}

async function findLocalReferenceAudio(
  directoryPath: string
): Promise<{ path: string; filename: string; byteSize: number } | null> {
  for (const extension of SUPPORTED_REFERENCE_AUDIO_EXTENSIONS) {
    const filename = `reference${extension}`;
    const sourcePath = path.join(directoryPath, filename);

    if (!(await fileExists(sourcePath))) {
      continue;
    }

    const sourceStats = await stat(sourcePath);
    return {
      path: sourcePath,
      filename,
      byteSize: sourceStats.size
    };
  }

  return null;
}

async function readOptionalTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const fileStats = await stat(filePath);
    return fileStats.isFile();
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }

    throw error;
  }
}

function inferReferenceMimeType(filePathOrName: string): string {
  switch (path.extname(filePathOrName).toLowerCase() as SupportedReferenceAudioExtension | string) {
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
    case ".mp4":
      return "audio/mp4";
    case ".webm":
      return "audio/webm";
    case ".ogg":
      return "audio/ogg";
    case ".flac":
      return "audio/flac";
    case ".wav":
      return "audio/wav";
    default:
      return "application/octet-stream";
  }
}

function sanitizeMetadataFilename(filename: string | undefined): string {
  if (!filename) {
    return "";
  }

  return path.basename(filename).replace(/[\r\n]+/g, " ").trim().slice(0, 180);
}

function extractFilenameFromMessage(message: string): string {
  const match = message.match(/(?:audio file|file)(?: is [^:]+)?:\s*([^.\s][^.]*)/i);
  return match?.[1]?.trim() ?? "";
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
