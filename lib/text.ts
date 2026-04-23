const DEFAULT_TARGET_MIN_WORDS = 180;
const DEFAULT_TARGET_MAX_WORDS = 240;
const DEFAULT_HARD_MAX_WORDS = 280;

const sentenceSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("en", { granularity: "sentence" })
    : null;

export interface TextChunk {
  text: string;
  wordCount: number;
}

export interface ChunkOptions {
  targetMinWords?: number;
  targetMaxWords?: number;
  hardMaxWords?: number;
}

export function cleanText(rawText: string): string {
  const withoutCodeBlocks = rawText
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/`([^`]+)`/g, "$1");

  const paragraphs: string[] = [];
  let currentLines: string[] = [];

  for (const rawLine of withoutCodeBlocks.replace(/\r\n/g, "\n").split("\n")) {
    const cleanedLine = cleanLine(rawLine);

    if (!cleanedLine) {
      if (currentLines.length > 0) {
        paragraphs.push(currentLines.join(" "));
        currentLines = [];
      }
      continue;
    }

    currentLines.push(cleanedLine);
  }

  if (currentLines.length > 0) {
    paragraphs.push(currentLines.join(" "));
  }

  return paragraphs
    .join("\n\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function chunkText(
  cleanedText: string,
  options: ChunkOptions = {}
): TextChunk[] {
  const targetMinWords = options.targetMinWords ?? DEFAULT_TARGET_MIN_WORDS;
  const targetMaxWords = options.targetMaxWords ?? DEFAULT_TARGET_MAX_WORDS;
  const hardMaxWords = options.hardMaxWords ?? DEFAULT_HARD_MAX_WORDS;
  const paragraphs = cleanedText
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks: TextChunk[] = [];
  let currentSentences: string[] = [];
  let currentWordCount = 0;

  const flushChunk = () => {
    if (currentSentences.length === 0) {
      return;
    }

    chunks.push({
      text: currentSentences.join(" ").trim(),
      wordCount: currentWordCount
    });

    currentSentences = [];
    currentWordCount = 0;
  };

  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
    const paragraph = paragraphs[paragraphIndex];
    const sentences = splitIntoSentences(paragraph).flatMap((sentence) =>
      splitOversizedSentence(sentence, hardMaxWords)
    );

    for (const sentence of sentences) {
      const sentenceWordCount = countWords(sentence);

      if (sentenceWordCount === 0) {
        continue;
      }

      const wouldExceedHardMax =
        currentWordCount > 0 && currentWordCount + sentenceWordCount > hardMaxWords;
      const shouldFlushForTarget =
        currentWordCount >= targetMinWords &&
        currentWordCount + sentenceWordCount > targetMaxWords;

      if (wouldExceedHardMax || shouldFlushForTarget) {
        flushChunk();
      }

      currentSentences.push(sentence);
      currentWordCount += sentenceWordCount;
    }

    const isLastParagraph = paragraphIndex === paragraphs.length - 1;
    if (!isLastParagraph && currentWordCount >= targetMinWords) {
      flushChunk();
    }
  }

  flushChunk();

  if (chunks.length > 1) {
    const lastChunk = chunks[chunks.length - 1];
    const previousChunk = chunks[chunks.length - 2];

    if (lastChunk.wordCount < targetMinWords) {
      if (previousChunk.wordCount + lastChunk.wordCount <= hardMaxWords) {
        previousChunk.text = `${previousChunk.text} ${lastChunk.text}`.trim();
        previousChunk.wordCount += lastChunk.wordCount;
        chunks.pop();
      }
    }
  }

  return chunks;
}

export function slugifyFilename(input: string, fallback = "voiceover"): string {
  const normalized = input
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

function cleanLine(rawLine: string): string {
  const line = rawLine.trim();

  if (!line) {
    return "";
  }

  if (/^(image|photo|caption|alt(?:\s+text)?)\s*:/i.test(line)) {
    return "";
  }

  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
    return "";
  }

  const wasHeading = /^\s{0,3}#{1,6}\s+/.test(rawLine);
  const wasBullet =
    /^\s{0,3}[-*+•]\s+/.test(rawLine) || /^\s{0,3}\d+[.)]\s+/.test(rawLine);

  let cleaned = line
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\((?:mailto:|https?:\/\/)[^)]+\)/g, "$1")
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, "$1")
    .replace(/^>\s?/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s{0,3}[-*+•]\s+/, "")
    .replace(/^\s{0,3}\d+[.)]\s+/, "")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\bhttps?:\/\/\S+\b/gi, " ")
    .replace(/\bwww\.\S+\b/gi, " ")
    .replace(/(^|[\s(])\$ ?(\d[\d,]*(?:\.\d+)?)(?=$|[\s),.!?;:])/g, "$1$2 dollars")
    .replace(/%/g, " percent")
    .replace(/[_*~]+/g, "")
    .replace(/[\uFE0F\u200D]/g, "")
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}/gu, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return "";
  }

  if ((wasHeading || wasBullet) && !/[.!?;:]$/.test(cleaned)) {
    cleaned = `${cleaned}.`;
  }

  return cleaned;
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

  const words = sentence.split(/\s+/).filter(Boolean);
  const parts: string[] = [];

  for (let index = 0; index < words.length; index += hardMaxWords) {
    parts.push(words.slice(index, index + hardMaxWords).join(" ").trim());
  }

  return parts.filter(Boolean);
}

function countWords(text: string): number {
  return text.match(/\b[\p{L}\p{N}'’-]+\b/gu)?.length ?? 0;
}
