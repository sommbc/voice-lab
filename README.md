# Voiceover

Private tool for converting pasted long-form text into one narration file using Mistral's Voxtral TTS. Paste markdown or plain text, generate audio with a saved voice clone, and download the result as MP3 or WAV.

## Current behavior

- Narration Mode is the default path for long-form essays.
- Long inputs are cleaned, segmented automatically, generated section by section, normalized with `ffmpeg`, merged, then normalized again before delivery.
- Short inputs can still run in a single pass.
- The legacy full-document request path remains available as `Single-pass experimental`.

## Running locally

```
npm install
npm run dev
```

Requires Node.js 18+. The server uses `ffmpeg` for narration normalization and multi-segment merges; it will use the bundled binary when available and fall back to a system `ffmpeg` on PATH.

## Tests

```
npm test
```

## Environment variables

```
MISTRAL_API_KEY
MISTRAL_VOICE_ID
```

Both are required. The app will return an error on generation if either is missing.
