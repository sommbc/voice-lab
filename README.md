# Voiceover

Private tool for converting pasted long-form text into one narration file using Mistral's Voxtral TTS. Paste markdown or plain text, generate audio with a saved voice clone, and download the result as MP3 or WAV.

## Current behavior

- Continuous Read is the default path for long-form essays.
- The app cleans the full document, sends one Mistral TTS request first, then applies final mastering to the completed file before delivery.
- If the full-document request fails for a chunking-worthy reason, the app falls back to segmented generation, optional join smoothing, merge, and final mastering.
- Advanced controls can force segmented generation directly when needed.

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
