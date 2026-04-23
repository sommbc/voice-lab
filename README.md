# Voiceover

Private tool for converting pasted long-form text into a single MP3 using Mistral's Voxtral TTS. Paste markdown or plain text, generate audio with a saved voice clone, download the file. Single-pass mode by default with automatic fallback chunking for large documents.

## Running locally

```
npm install
npm run dev
```

Requires Node.js 18+ and ffmpeg installed locally (used for multi-chunk merges).

## Environment variables

```
MISTRAL_API_KEY
MISTRAL_VOICE_ID
```

Both are required. The app will return an error on generation if either is missing.
