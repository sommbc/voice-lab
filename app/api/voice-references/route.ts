import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createUploadTempDirectory,
  formatVoiceReferenceSaveError,
  loadVoiceReference,
  removePrivateTempDirectory,
  saveVoiceReference,
  toClientVoiceReferenceMetadata
} from "@/lib/voice-reference-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const reference = await loadVoiceReference();

    return Response.json({
      reference: reference ? toClientVoiceReferenceMetadata(reference.metadata) : null
    });
  } catch (error) {
    return Response.json(
      {
        reference: null,
        error: formatVoiceReferenceSaveError(error)
      },
      { status: 400 }
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "Request body must be multipart form data." }, { status: 400 });
  }

  const audio = formData.get("audio");
  const transcript = formData.get("transcript");

  if (!(audio instanceof File)) {
    return Response.json({ error: "Reference audio file is required." }, { status: 400 });
  }

  if (typeof transcript !== "string") {
    return Response.json({ error: "Reference transcript is required." }, { status: 400 });
  }

  let tempDirectoryPath = "";

  try {
    tempDirectoryPath = await createUploadTempDirectory();
    const uploadPath = path.join(tempDirectoryPath, `reference-upload${getUploadExtension(audio)}`);
    await writeFile(uploadPath, Buffer.from(await audio.arrayBuffer()));

    const reference = await saveVoiceReference({
      sourceAudioPath: uploadPath,
      transcript,
      originalFilename: audio.name || path.basename(uploadPath),
      originalMimeType: audio.type || "application/octet-stream",
      originalByteSize: audio.size
    });

    return Response.json({
      reference: toClientVoiceReferenceMetadata(reference.metadata)
    });
  } catch (error) {
    return Response.json(
      {
        error: sanitizeReferenceError(formatVoiceReferenceSaveError(error, audio.name))
      },
      { status: 400 }
    );
  } finally {
    if (tempDirectoryPath) {
      await removePrivateTempDirectory(tempDirectoryPath);
    }
  }
}

function getUploadExtension(file: File): string {
  const lowerName = file.name.toLowerCase();
  const nameExtension = path.extname(lowerName);

  if (
    [".wav", ".mp3", ".m4a", ".mp4", ".aac", ".webm", ".ogg", ".flac"].includes(
      nameExtension
    )
  ) {
    return nameExtension;
  }

  switch (file.type) {
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
    case "audio/m4a":
    case "video/mp4":
      return ".m4a";
    case "audio/webm":
      return ".webm";
    case "audio/ogg":
      return ".ogg";
    case "audio/flac":
      return ".flac";
    case "audio/wav":
    case "audio/x-wav":
    default:
      return ".wav";
  }
}

function sanitizeReferenceError(message: string): string {
  return message
    .replace(/(?:\/Users|\/private\/var|\/var|\/tmp)\/[^\s'"]+/g, "[private-path]")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/base64|authorization|bearer/i.test(line))
    .join(" ")
    .slice(0, 260);
}
