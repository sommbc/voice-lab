import path from "node:path";
import { loadEnvConfig } from "@next/env";
import {
  DEFAULT_VOICE_REFERENCE_ID,
  getVoiceReferenceStoragePaths
} from "../lib/storage";
import {
  CANONICAL_REFERENCE_CHANNELS,
  CANONICAL_REFERENCE_SAMPLE_RATE,
  formatVoiceReferenceSaveError,
  prepareVoiceReferenceFromLocalFolder,
  resolveVoiceLabDataDir
} from "../lib/voice-reference-store";

loadEnvConfig(process.cwd());

void main();

async function main(): Promise<void> {
  const dataDir = resolveVoiceLabDataDir();
  const paths = getVoiceReferenceStoragePaths({ dataDir });

  try {
    const result = await prepareVoiceReferenceFromLocalFolder({ dataDir });

    if (!result.reference) {
      console.error(`[reference:prepare] fail: ${result.message}`);
      console.error(
        `[reference:prepare] expected folder: ${path.join(
          dataDir,
          "references",
          DEFAULT_VOICE_REFERENCE_ID
        )}`
      );
      process.exit(1);
    }

    const action =
      result.action === "transcoded"
        ? "converted and saved"
        : result.action === "metadata-written"
          ? "metadata written"
          : "ready";

    console.log(`[reference:prepare] success: ${action}`);
    console.log(
      `[reference:prepare] canonical audio: ${path.relative(dataDir, paths.referenceAudioPath)}`
    );
    console.log(`[reference:prepare] transcript: ${path.relative(dataDir, paths.transcriptPath)}`);
    console.log(`[reference:prepare] metadata: ${path.relative(dataDir, paths.metadataPath)}`);
    console.log(
      `[reference:prepare] canonical format: mono ${CANONICAL_REFERENCE_SAMPLE_RATE} Hz PCM WAV (${CANONICAL_REFERENCE_CHANNELS} channel)`
    );
    console.log(
      `[reference:prepare] transcript characters: ${result.reference.metadata.transcriptCharacters}`
    );
  } catch (error) {
    console.error(`[reference:prepare] fail: ${formatVoiceReferenceSaveError(error)}`);
    process.exit(1);
  }
}
