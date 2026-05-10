import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CANONICAL_REFERENCE_SAMPLE_RATE,
  formatVoiceReferenceSaveError,
  prepareVoiceReferenceFromLocalFolder,
  saveVoiceReference,
  type VoiceReferenceMetadata
} from "../lib/voice-reference-store";

const EXACT_TRANSCRIPT =
  "This is the exact transcript for a reusable voice reference sample.";
const CANONICAL_WAV_BYTES = Buffer.from("RIFF....WAVEfmt canonical voice reference", "utf8");

test("voice reference save accepts a misnamed non-WAV upload when transcoding succeeds", async () => {
  const dataDir = await createTempDataDir();

  try {
    const sourcePath = path.join(dataDir, "reference-upload.wav");
    await writeFile(sourcePath, Buffer.from("webm bytes with a misleading wav extension"));

    const reference = await saveVoiceReference({
      sourceAudioPath: sourcePath,
      transcript: EXACT_TRANSCRIPT,
      dataDir,
      originalFilename: "browser-reference.webm",
      originalMimeType: "audio/webm",
      originalByteSize: 42,
      transcodeAudio: async ({ outputPath }) => {
        await writeFile(outputPath, CANONICAL_WAV_BYTES);
      }
    });

    const metadataRaw = await readFile(
      path.join(dataDir, "references", "default", "metadata.json"),
      "utf8"
    );
    const metadata = JSON.parse(metadataRaw) as VoiceReferenceMetadata;

    assert.equal(reference.metadata.savedCanonicalFilename, "reference.wav");
    assert.equal(reference.metadata.originalFilename, "browser-reference.webm");
    assert.equal(reference.metadata.originalMimeType, "audio/webm");
    assert.equal(reference.metadata.originalByteSize, 42);
    assert.equal(reference.metadata.canonicalSampleRate, CANONICAL_REFERENCE_SAMPLE_RATE);
    assert.equal(metadata.audioSha256.length, 64);
    assert.equal(metadata.transcriptSha256.length, 64);
    assert.equal(metadataRaw.includes(EXACT_TRANSCRIPT), false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("unsupported reference audio reports the filename without ffmpeg internals", () => {
  const message = formatVoiceReferenceSaveError(
    new Error("ffmpeg failed while decoding uploaded audio"),
    "reference-upload.wav"
  );

  assert.equal(
    message,
    "Could not read this audio file: reference-upload.wav. Try MP3, M4A, WAV, WebM, or OGG."
  );
  assert.equal(message.includes("ffmpeg version"), false);
  assert.equal(message.includes("/Users/"), false);
});

test("reference prepare finds transcript plus mp3 or m4a and writes canonical metadata", async () => {
  for (const extension of [".mp3", ".m4a"]) {
    const dataDir = await createTempDataDir();

    try {
      const referenceDir = path.join(dataDir, "references", "default");
      await mkdir(referenceDir, { recursive: true });
      await writeFile(path.join(referenceDir, "transcript.txt"), `${EXACT_TRANSCRIPT}\n`, "utf8");
      await writeFile(path.join(referenceDir, `reference${extension}`), Buffer.from("source audio"));

      const result = await prepareVoiceReferenceFromLocalFolder({
        dataDir,
        transcodeAudio: async ({ outputPath }) => {
          await writeFile(outputPath, CANONICAL_WAV_BYTES);
        }
      });
      const metadataRaw = await readFile(path.join(referenceDir, "metadata.json"), "utf8");
      const metadata = JSON.parse(metadataRaw) as VoiceReferenceMetadata;

      assert.equal(result.action, "transcoded");
      assert.equal(metadata.originalFilename, `reference${extension}`);
      assert.equal(metadata.savedCanonicalFilename, "reference.wav");
      assert.equal(metadataRaw.includes(EXACT_TRANSCRIPT), false);
      assert.equal(
        await readFile(path.join(referenceDir, "reference.wav"), "utf8"),
        CANONICAL_WAV_BYTES.toString("utf8")
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});

test("reference prepare uses existing reference.wav and writes metadata without transcript contents", async () => {
  const dataDir = await createTempDataDir();

  try {
    const referenceDir = path.join(dataDir, "references", "default");
    await mkdir(referenceDir, { recursive: true });
    await writeFile(path.join(referenceDir, "transcript.txt"), `${EXACT_TRANSCRIPT}\n`, "utf8");
    await writeFile(path.join(referenceDir, "reference.wav"), CANONICAL_WAV_BYTES);

    const result = await prepareVoiceReferenceFromLocalFolder({
      dataDir,
      transcodeAudio: async () => {
        throw new Error("existing canonical WAV should not be transcoded");
      }
    });
    const metadataRaw = await readFile(path.join(referenceDir, "metadata.json"), "utf8");
    const metadata = JSON.parse(metadataRaw) as VoiceReferenceMetadata;

    assert.equal(result.action, "metadata-written");
    assert.equal(metadata.originalFilename, "reference.wav");
    assert.equal(metadata.savedCanonicalFilename, "reference.wav");
    assert.equal(metadataRaw.includes(EXACT_TRANSCRIPT), false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function createTempDataDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "voice-lab-reference-test-"));
}
