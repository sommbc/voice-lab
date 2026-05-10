import { createHash } from "node:crypto";
import {
  chunkText,
  type PreparedParagraph,
  type TextChunk
} from "./text";
import type { VoxcpmCloneMode } from "./providers/types";

export const VOXCPM_CHUNK_OPTIONS = {
  targetMinWords: 90,
  targetMaxWords: 140,
  hardMaxWords: 170
} as const;

export type VoxcpmSegmentPromptPlan = {
  segmentIndex: number;
  segmentNumber: number;
  text: string;
  wordCount: number;
  promptSource: "none" | "reference" | "previous-segment";
  promptText: string | null;
};

export function chunkTextForVoxcpm(input: string | PreparedParagraph[]): TextChunk[] {
  return chunkText(input, VOXCPM_CHUNK_OPTIONS);
}

export function createVoxcpmSegmentPromptPlan({
  segments,
  referenceTranscript,
  cloneMode,
  forceFirstPrompt
}: {
  segments: Pick<TextChunk, "text" | "wordCount">[];
  referenceTranscript: string;
  cloneMode: VoxcpmCloneMode;
  forceFirstPrompt: boolean;
}): VoxcpmSegmentPromptPlan[] {
  return segments.map((segment, index) => {
    if (index === 0) {
      const useReferencePrompt = cloneMode === "ultimate" || forceFirstPrompt;

      return {
        segmentIndex: index,
        segmentNumber: index + 1,
        text: segment.text,
        wordCount: segment.wordCount,
        promptSource: useReferencePrompt ? "reference" : "none",
        promptText: useReferencePrompt ? referenceTranscript : null
      };
    }

    return {
      segmentIndex: index,
      segmentNumber: index + 1,
      text: segment.text,
      wordCount: segment.wordCount,
      promptSource: "previous-segment",
      promptText: segments[index - 1]?.text ?? null
    };
  });
}

export function hashPrivateText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
