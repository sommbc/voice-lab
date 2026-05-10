export const DEFAULT_TARGET_MIN_WORDS = 220;
export const DEFAULT_TARGET_MAX_WORDS = 280;
export const DEFAULT_HARD_MAX_WORDS = 295;

const sentenceSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("en", { granularity: "sentence" })
    : null;

type ParagraphKind = "heading" | "bullet" | "paragraph";

export interface TextChunk {
  text: string;
  wordCount: number;
}

export interface SegmentContinuityPrompt {
  input: string;
  targetText: string;
  previousContext: string;
  nextContext: string;
  contextOverlapUsed: boolean;
  instructionStrength: "none" | "standard" | "strong";
  targetWordCount: number;
  inputWordCount: number;
}

export interface ChunkBoundaryRepair {
  applied: boolean;
  strategy: "merge" | "move-next-first-sentence" | "move-previous-last-sentence" | "none";
  reason: string;
  chunks: TextChunk[];
  boundaryIndex: number;
}

export interface PreparedParagraph {
  kind: ParagraphKind;
  text: string;
  wordCount: number;
}

export interface PreparedText {
  cleanedText: string;
  paragraphs: PreparedParagraph[];
  wordCount: number;
}

export interface ChunkOptions {
  targetMinWords?: number;
  targetMaxWords?: number;
  hardMaxWords?: number;
}

export function prepareTextForSpeech(rawText: string): PreparedText {
  const normalizedText = normalizeSourceText(stripFrontMatter(rawText));
  const paragraphs: PreparedParagraph[] = [];
  let currentLines: string[] = [];

  const flushParagraph = () => {
    if (currentLines.length === 0) {
      return;
    }

    const text = currentLines.join(" ").trim();
    const wordCount = countWords(text);

    if (wordCount > 0) {
      paragraphs.push({
        kind: "paragraph",
        text,
        wordCount
      });
    }

    currentLines = [];
  };

  for (const rawLine of normalizedText.replace(/\r\n/g, "\n").split("\n")) {
    const cleanedLine = cleanLine(rawLine);

    if (!cleanedLine) {
      flushParagraph();
      continue;
    }

    if (cleanedLine.kind === "paragraph") {
      currentLines.push(cleanedLine.text);
      continue;
    }

    flushParagraph();
    paragraphs.push({
      kind: cleanedLine.kind,
      text: cleanedLine.text,
      wordCount: countWords(cleanedLine.text)
    });
  }

  flushParagraph();

  const mergedParagraphs = mergeHeadingParagraphs(paragraphs);
  const cleanedText = mergedParagraphs.map((paragraph) => paragraph.text).join("\n\n").trim();

  return {
    cleanedText,
    paragraphs: mergedParagraphs,
    wordCount: mergedParagraphs.reduce((total, paragraph) => total + paragraph.wordCount, 0)
  };
}

export function cleanText(rawText: string): string {
  return prepareTextForSpeech(rawText).cleanedText;
}

export function chunkText(
  input: string | PreparedParagraph[],
  options: ChunkOptions = {}
): TextChunk[] {
  const targetMinWords = options.targetMinWords ?? DEFAULT_TARGET_MIN_WORDS;
  const targetMaxWords = options.targetMaxWords ?? DEFAULT_TARGET_MAX_WORDS;
  const hardMaxWords = options.hardMaxWords ?? DEFAULT_HARD_MAX_WORDS;
  const paragraphs = normalizeChunkInput(input);
  const chunkUnits = paragraphs.flatMap((paragraph) =>
    splitOversizedParagraph(paragraph, {
      targetMinWords,
      targetMaxWords,
      hardMaxWords
    })
  );

  const chunks: TextChunk[] = [];
  let currentParts: TextChunk[] = [];
  let currentWordCount = 0;

  const flushChunk = () => {
    if (currentParts.length === 0) {
      return;
    }

    chunks.push({
      text: currentParts.map((part) => part.text).join("\n\n").trim(),
      wordCount: currentWordCount
    });

    currentParts = [];
    currentWordCount = 0;
  };

  for (const part of chunkUnits) {
    const previousPart = currentParts[currentParts.length - 1];
    const wouldExceedHardMax =
      currentWordCount > 0 && currentWordCount + part.wordCount > hardMaxWords;
    const shouldFlushForTarget =
      currentWordCount >= targetMinWords &&
      currentWordCount + part.wordCount > targetMaxWords &&
      !shouldKeepBoundaryOpen(previousPart, part);

    if (wouldExceedHardMax || shouldFlushForTarget) {
      flushChunk();
    }

    currentParts.push(part);
    currentWordCount += part.wordCount;
  }

  flushChunk();
  rebalanceTrailingChunk(chunks, targetMinWords, hardMaxWords);
  rebalanceBoundarySensitiveChunks(chunks, targetMinWords, hardMaxWords);

  return chunks;
}

export function buildSegmentContinuityPrompt({
  previousText,
  targetText,
  nextText,
  enabled = true,
  instructionStrength = "standard"
}: {
  previousText?: string;
  targetText: string;
  nextText?: string;
  enabled?: boolean;
  instructionStrength?: "standard" | "strong";
}): SegmentContinuityPrompt {
  const previousContext = previousText ? extractLastSentences(previousText, 2) : "";
  const nextContext = nextText ? extractFirstSentences(nextText, 1) : "";
  const contextOverlapUsed = enabled && Boolean(previousContext || nextContext);
  const targetWordCount = countWords(targetText);

  if (!contextOverlapUsed) {
    return {
      input: targetText,
      targetText,
      previousContext: "",
      nextContext: "",
      contextOverlapUsed: false,
      instructionStrength: "none",
      targetWordCount,
      inputWordCount: targetWordCount
    };
  }

  const continuityInstruction =
    instructionStrength === "strong"
      ? "You are continuing the same narration take. Match the exact same voice, tone, pacing, energy, emphasis, and emotional delivery from the previous passage. Do not restart with a new announcer tone. Read aloud only the target passage."
      : "You are continuing the same narration take. Match the same voice, tone, pacing, energy, and emotional delivery from the previous passage. Read aloud only the target passage.";
  const parts = [
    continuityInstruction,
    previousContext
      ? `Previous context for continuity only, do not read aloud:\n${previousContext}`
      : "",
    `Target passage to read aloud:\n${targetText}`,
    nextContext ? `Next context for pacing only, do not read aloud:\n${nextContext}` : ""
  ].filter(Boolean);
  const input = parts.join("\n\n");

  return {
    input,
    targetText,
    previousContext,
    nextContext,
    contextOverlapUsed: true,
    instructionStrength,
    targetWordCount,
    inputWordCount: countWords(input)
  };
}

export function extractLastSentences(text: string, sentenceCount: number): string {
  return splitIntoSentences(text).slice(-sentenceCount).join(" ").trim();
}

export function extractFirstSentences(text: string, sentenceCount: number): string {
  return splitIntoSentences(text).slice(0, sentenceCount).join(" ").trim();
}

export function repairChunkBoundary(
  chunks: TextChunk[],
  boundaryIndex: number,
  {
    hardMaxWords = DEFAULT_HARD_MAX_WORDS,
    targetMinWords = DEFAULT_TARGET_MIN_WORDS
  }: {
    hardMaxWords?: number;
    targetMinWords?: number;
  } = {}
): ChunkBoundaryRepair {
  const previousIndex = boundaryIndex - 1;
  const nextIndex = boundaryIndex;
  const previous = chunks[previousIndex];
  const next = chunks[nextIndex];

  if (!previous || !next) {
    return {
      applied: false,
      strategy: "none",
      reason: "boundary-index-out-of-range",
      chunks,
      boundaryIndex
    };
  }

  if (!isBoundaryLikelyTonalCliff(previous.text, next.text)) {
    return {
      applied: false,
      strategy: "none",
      reason: "boundary-not-sensitive",
      chunks,
      boundaryIndex
    };
  }

  if (previous.wordCount + next.wordCount <= hardMaxWords) {
    const repaired = chunks.slice();
    repaired.splice(previousIndex, 2, {
      text: `${previous.text}\n\n${next.text}`.trim(),
      wordCount: previous.wordCount + next.wordCount
    });

    return {
      applied: true,
      strategy: "merge",
      reason: "adjacent-chunks-fit-under-hard-cap",
      chunks: repaired,
      boundaryIndex
    };
  }

  const nextSentences = splitIntoSentences(next.text);
  const firstNextSentence = nextSentences[0] ?? "";
  const firstNextWordCount = countWords(firstNextSentence);

  if (
    firstNextSentence &&
    previous.wordCount + firstNextWordCount <= hardMaxWords &&
    next.wordCount - firstNextWordCount >= Math.min(targetMinWords, 120)
  ) {
    const repaired = chunks.slice();
    repaired[previousIndex] = {
      text: `${previous.text}\n\n${firstNextSentence}`.trim(),
      wordCount: previous.wordCount + firstNextWordCount
    };
    repaired[nextIndex] = {
      text: nextSentences.slice(1).join(" ").trim(),
      wordCount: next.wordCount - firstNextWordCount
    };

    return {
      applied: true,
      strategy: "move-next-first-sentence",
      reason: "moved-sensitive-next-opening-into-previous-chunk",
      chunks: repaired,
      boundaryIndex
    };
  }

  const previousSentences = splitIntoSentences(previous.text);
  const lastPreviousSentence = previousSentences.at(-1) ?? "";
  const lastPreviousWordCount = countWords(lastPreviousSentence);

  if (
    lastPreviousSentence &&
    next.wordCount + lastPreviousWordCount <= hardMaxWords &&
    previous.wordCount - lastPreviousWordCount >= Math.min(targetMinWords, 120)
  ) {
    const repaired = chunks.slice();
    repaired[previousIndex] = {
      text: previousSentences.slice(0, -1).join(" ").trim(),
      wordCount: previous.wordCount - lastPreviousWordCount
    };
    repaired[nextIndex] = {
      text: `${lastPreviousSentence}\n\n${next.text}`.trim(),
      wordCount: next.wordCount + lastPreviousWordCount
    };

    return {
      applied: true,
      strategy: "move-previous-last-sentence",
      reason: "moved-sensitive-previous-ending-into-next-chunk",
      chunks: repaired,
      boundaryIndex
    };
  }

  return {
    applied: false,
    strategy: "none",
    reason: "adjacent-chunks-too-large-to-repair-safely",
    chunks,
    boundaryIndex
  };
}

export function slugifyFilename(input: string, fallback = "voice-lab"): string {
  const normalized = input
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

function normalizeChunkInput(input: string | PreparedParagraph[]): PreparedParagraph[] {
  if (typeof input !== "string") {
    return input.filter((paragraph) => paragraph.wordCount > 0);
  }

  return mergeHeadingParagraphs(
    input
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .map((paragraph) => ({
        kind: isHeadingLikeParagraph(paragraph) ? "heading" : "paragraph",
        text: paragraph,
        wordCount: countWords(paragraph)
      }))
  );
}

function splitOversizedParagraph(
  paragraph: PreparedParagraph,
  options: Required<ChunkOptions>
): TextChunk[] {
  if (paragraph.wordCount <= options.hardMaxWords) {
    return [
      {
        text: paragraph.text,
        wordCount: paragraph.wordCount
      }
    ];
  }

  const sentenceGroups: TextChunk[] = [];
  let currentSentences: string[] = [];
  let currentWordCount = 0;

  const flushGroup = () => {
    if (currentSentences.length === 0) {
      return;
    }

    sentenceGroups.push({
      text: currentSentences.join(" ").trim(),
      wordCount: currentWordCount
    });

    currentSentences = [];
    currentWordCount = 0;
  };

  for (const sentence of splitIntoSentences(paragraph.text).flatMap((value) =>
    splitOversizedSentence(value, options.hardMaxWords)
  )) {
    const sentenceWordCount = countWords(sentence);

    if (sentenceWordCount === 0) {
      continue;
    }

    const wouldExceedHardMax =
      currentWordCount > 0 && currentWordCount + sentenceWordCount > options.hardMaxWords;
    const shouldFlushForTarget =
      currentWordCount >= options.targetMinWords &&
      currentWordCount + sentenceWordCount > options.targetMaxWords;

    if (wouldExceedHardMax || shouldFlushForTarget) {
      flushGroup();
    }

    currentSentences.push(sentence);
    currentWordCount += sentenceWordCount;
  }

  flushGroup();
  return sentenceGroups;
}

function mergeHeadingParagraphs(paragraphs: PreparedParagraph[]): PreparedParagraph[] {
  const merged: PreparedParagraph[] = [];

  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    const nextParagraph = paragraphs[index + 1];

    if (paragraph.kind === "heading" && nextParagraph) {
      merged.push({
        kind: nextParagraph.kind,
        text: `${paragraph.text}\n\n${nextParagraph.text}`,
        wordCount: paragraph.wordCount + nextParagraph.wordCount
      });
      index += 1;
      continue;
    }

    merged.push(paragraph);
  }

  return merged;
}

function rebalanceTrailingChunk(
  chunks: TextChunk[],
  targetMinWords: number,
  hardMaxWords: number
): void {
  if (chunks.length < 2) {
    return;
  }

  const lastChunk = chunks[chunks.length - 1];
  const previousChunk = chunks[chunks.length - 2];

  if (lastChunk.wordCount >= targetMinWords) {
    return;
  }

  if (previousChunk.wordCount + lastChunk.wordCount <= hardMaxWords) {
    previousChunk.text = `${previousChunk.text}\n\n${lastChunk.text}`.trim();
    previousChunk.wordCount += lastChunk.wordCount;
    chunks.pop();
  }
}

function rebalanceBoundarySensitiveChunks(
  chunks: TextChunk[],
  targetMinWords: number,
  hardMaxWords: number
): void {
  let index = 1;
  const maxPasses = Math.max(1, chunks.length * 2);
  let passes = 0;

  while (index < chunks.length && passes < maxPasses) {
    passes += 1;
    const repair = repairChunkBoundary(chunks, index, { targetMinWords, hardMaxWords });

    if (!repair.applied) {
      index += 1;
      continue;
    }

    chunks.splice(0, chunks.length, ...repair.chunks);
    index += 1;
  }
}

function shouldKeepBoundaryOpen(previousPart: TextChunk | undefined, nextPart: TextChunk): boolean {
  if (!previousPart) {
    return false;
  }

  return (
    isBoundarySensitivePart(previousPart) ||
    isBoundarySensitivePart(nextPart) ||
    isShortFollowUpParagraph(nextPart)
  );
}

function isBoundarySensitivePart(part: TextChunk): boolean {
  const trimmed = part.text.trim();

  if (!trimmed) {
    return false;
  }

  if (trimmed.endsWith(":") || isQuoteLikeParagraph(trimmed)) {
    return true;
  }

  const sentenceCount = splitIntoSentences(trimmed).length;

  if (part.wordCount <= 18 && sentenceCount <= 1) {
    return true;
  }

  return part.wordCount <= 48 && sentenceCount <= 2 && isHeadingLikeParagraph(trimmed);
}

function isBoundaryLikelyTonalCliff(previousText: string, nextText: string): boolean {
  const previous = previousText.trim();
  const next = nextText.trim();
  const lastSentence = splitIntoSentences(previous).at(-1) ?? previous;
  const firstSentence = splitIntoSentences(next)[0] ?? next;

  if (!previous || !next) {
    return false;
  }

  return (
    /[:;]$/.test(lastSentence) ||
    isQuoteLikeParagraph(lastSentence) ||
    countWords(lastSentence) <= 12 ||
    /^(but|and|so|because|then|still|instead|meanwhile|this|that|these|those|which|the point|the problem|the truth)\b/i.test(
      firstSentence
    ) ||
    /^(this is|that is|here is|the question is|the point is|the problem is|the future|the standard)\b/i.test(
      firstSentence
    )
  );
}

function isShortFollowUpParagraph(part: TextChunk): boolean {
  const trimmed = part.text.trim();

  if (!trimmed) {
    return false;
  }

  return (
    part.wordCount <= 40 ||
    /^[\"'([{]/.test(trimmed) ||
    /^(and|but|or|so|because|then|still|instead|meanwhile|for example|for instance)\b/i.test(
      trimmed
    )
  );
}

function isQuoteLikeParagraph(text: string): boolean {
  return /^[\"']/.test(text) || /[\"']$/.test(text);
}

function cleanLine(rawLine: string): PreparedParagraph | null {
  const line = rawLine.trim();

  if (!line) {
    return null;
  }

  if (shouldDropLine(line)) {
    return null;
  }

  const isHeading = /^\s{0,3}#{1,6}\s+/.test(rawLine);
  const isBullet =
    /^\s{0,3}[-*+•]\s+/.test(rawLine) || /^\s{0,3}\d+[.)]\s+/.test(rawLine);

  let cleaned = line
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\((?:mailto:|https?:\/\/)[^)]+\)/g, "$1")
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, "$1")
    .replace(/\[\^?\d+\]/g, " ")
    .replace(/\[\^?[a-z]\]/gi, " ")
    .replace(/^>\s?/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s{0,3}[-*+•]\s+/, "")
    .replace(/^\s{0,3}\d+[.)]\s+/, "")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\bhttps?:\/\/\S+\b/gi, " ")
    .replace(/\bwww\.\S+\b/gi, " ")
    .replace(/(^|[\s(])\$ ?(\d[\d,]*(?:\.\d+)?)(?=$|[\s),.!?;:])/g, "$1$2 dollars")
    .replace(/(\d)\s*%/g, "$1 percent")
    .replace(/%/g, " percent")
    .replace(/[_*~]+/g, "")
    .replace(/[§¶†‡©®™]/g, " ")
    .replace(/[\uFE0F\u200B-\u200D]/g, "")
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}/gu, "")
    .trim();

  cleaned = applySpeechSubstitutions(cleaned);

  if (!cleaned) {
    return null;
  }

  if ((isHeading || isBullet) && !/[.!?;:]$/.test(cleaned)) {
    cleaned = `${cleaned}.`;
  }

  return {
    kind: isHeading ? "heading" : isBullet ? "bullet" : "paragraph",
    text: cleaned,
    wordCount: countWords(cleaned)
  };
}

function shouldDropLine(line: string): boolean {
  if (/^(image|photo|caption|alt(?:\s+text)?|figcaption)\s*:/i.test(line)) {
    return true;
  }

  if (/^\[\^.+\]:/.test(line)) {
    return true;
  }

  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
    return true;
  }

  return /^(read in app|view in browser|subscribe|share|listen now|audio version|comments?|leave a comment|thanks for reading(?:[^a-z].*)?)$/i.test(
    line.replace(/[.!?]+$/, "").trim()
  );
}

function normalizeSourceText(rawText: string): string {
  return rawText
    .normalize("NFKC")
    .replace(/\u00A0|\u2007|\u202F/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s*--+\s*/g, ", ")
    .replace(/[–—]/g, ", ")
    .replace(/…/g, ".")
    .replace(/&nbsp;/gi, " ")
    .replace(/\t/g, " ");
}

function stripFrontMatter(rawText: string): string {
  if (!rawText.startsWith("---")) {
    return rawText;
  }

  const lines = rawText.replace(/\r\n/g, "\n").split("\n");
  let endIndex = -1;

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      endIndex = index;
      break;
    }
  }

  if (endIndex === -1) {
    return rawText;
  }

  return lines.slice(endIndex + 1).join("\n");
}

function applySpeechSubstitutions(text: string): string {
  return text
    .replace(/\bAI\b/g, "A.I.")
    .replace(/\bAPI\b/g, "A.P.I.")
    .replace(/\bCEO\b/g, "C.E.O.")
    .replace(/\bUS\b/g, "U.S.")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/([,.;!?])\1+/g, "$1")
    .replace(/"\s+/g, '"')
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
}

function splitIntoSentences(paragraph: string): string[] {
  if (sentenceSegmenter) {
    const segments = Array.from(sentenceSegmenter.segment(paragraph), (entry) =>
      entry.segment.trim()
    ).filter(Boolean);

    if (segments.length > 0) {
      return segments;
    }
  }

  return paragraph
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function splitOversizedSentence(sentence: string, hardMaxWords: number): string[] {
  if (countWords(sentence) <= hardMaxWords) {
    return [sentence];
  }

  const clauses = sentence
    .split(/(?<=[;:])\s+|(?<=,)\s+(?=(?:and|but|or|so|because|which|that|who|when|while|however)\b)/i)
    .map((part) => part.trim())
    .filter(Boolean);

  if (clauses.length > 1) {
    return mergeWordUnits(clauses, hardMaxWords);
  }

  return mergeWordUnits(sentence.split(/\s+/).filter(Boolean), hardMaxWords);
}

function mergeWordUnits(units: string[], hardMaxWords: number): string[] {
  const parts: string[] = [];
  let currentUnits: string[] = [];
  let currentWordCount = 0;

  const flush = () => {
    if (currentUnits.length === 0) {
      return;
    }

    parts.push(currentUnits.join(" ").trim());
    currentUnits = [];
    currentWordCount = 0;
  };

  for (const unit of units) {
    const wordCount = countWords(unit);

    if (wordCount === 0) {
      continue;
    }

    if (currentWordCount > 0 && currentWordCount + wordCount > hardMaxWords) {
      flush();
    }

    currentUnits.push(unit);
    currentWordCount += wordCount;
  }

  flush();
  return parts.filter(Boolean);
}

function isHeadingLikeParagraph(paragraph: string): boolean {
  const trimmed = paragraph.trim();

  if (!trimmed || trimmed.includes("\n")) {
    return false;
  }

  if (trimmed.endsWith(":")) {
    return true;
  }

  return countWords(trimmed) <= 12 && /^[\dA-Z][\w'".,:;!? -]+$/.test(trimmed);
}

function countWords(text: string): number {
  return text.match(/\b[\p{L}\p{N}'’-]+\b/gu)?.length ?? 0;
}
