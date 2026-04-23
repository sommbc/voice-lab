# Voiceover

Local Next.js operator tool that turns pasted long-form text into one downloadable MP3 using Mistral Voxtral TTS and a saved `voice_id`.

## Requirements

- Node.js 20+ (`22.x` tested)
- npm
- `ffmpeg` on your `PATH` if chunk fallback is used
- Mistral cloud API key and saved voice ID

## Setup

1. Copy `.env.example` to `.env.local`.
2. Fill in:
   - `MISTRAL_API_KEY`
   - `MISTRAL_VOICE_ID`
3. Install dependencies:

```bash
npm install
```

## Run

```bash
npm run dev
```

Open `http://localhost:3000`, paste text, click **Generate MP3**, and the browser will download one MP3.

## Build For A Local Production Run

```bash
npm run build
npm run start
```

## macOS ffmpeg Note

Install ffmpeg with Homebrew:

```bash
brew install ffmpeg
```

`ffmpeg` is only needed when the app falls back to chunking or when you turn single-pass mode off. If that path is used and `ffmpeg` is missing, the app returns a clear error.

## Default Behavior

- The app cleans the pasted document for speech.
- It then tries one full cleaned-document TTS request first.
- If Mistral accepts that request, you get one MP3 with no chunking step.
- If single-pass generation fails in a chunking-worthy way and fallback is enabled, the app chunks automatically, generates chunk MP3s, merges them, and still returns one final MP3.

## What It Does

- Cleans pasted text for speech:
  - strips common markdown formatting
  - removes raw URLs, image captions, bullets, and horizontal rules
  - normalizes whitespace
  - converts `%` to `percent`
  - converts obvious dollar amounts like `$19.99` to `19.99 dollars`
  - removes emoji
- Calls Mistral cloud TTS against the full cleaned document first:
  - `POST https://api.mistral.ai/v1/audio/speech`
  - model: `voxtral-mini-tts-2603`
  - `voice_id`: `MISTRAL_VOICE_ID`
  - `response_format`: `mp3`
  - `stream`: `false`
- If fallback chunking is needed:
  - splits cleaned text at sentence boundaries
  - targets `180` to `240` words per chunk
  - never exceeds `280` words per chunk
  - saves chunk MP3s to a temp directory
  - merges them into one final MP3 with ffmpeg
- Streams progress back to the browser:
  - cleaning
  - single-pass generation
  - fallback chunking when needed
  - generating chunk `X` of `Y`
  - merging when chunk mode is used
  - done

## Quick Validation Text

Use [samples/sample-post.md](samples/sample-post.md) for a fast paste-and-run test.

## Notes

- This is intentionally local-only. There is no auth, database, queue, or cloud storage layer.
- If a single-pass request fails for an input-related or invalid-audio reason, the server falls back to chunking automatically when fallback mode is enabled.
- If one chunk fails during fallback mode, the error names the chunk that failed.
- Temporary chunk files are assembled in a temp directory and removed after the response finishes.
