# Voiceover

Private tool for converting pasted long-form text into one narration file using Mistral's Voxtral TTS. Paste markdown or plain text, generate audio with a saved voice clone, and download the result as MP3 or WAV.

## Current behavior

- Continuous Read is the default path for long-form essays.
- The app cleans the full document, sends one Mistral TTS request first, then applies final mastering to the completed file before delivery.
- If the full-document request fails for a chunking-worthy reason, the app falls back to deterministic segmented generation: smaller Mistral-safe chunks, continuity context for each TTS request, WAV standardization, per-segment static loudness leveling, bounded fade-down correction, adaptive join pauses, mechanical and tonal seam scoring, selective bad-seam regeneration, boundary repair when a seam still sounds like a new take, boundary-aware edge matching, WAV merge, and gentle final mastering.
- The default delivery preset is Substack-ready MP3: Normal volume, `-16 LUFS` integrated loudness, `-1.5 dBTP` true peak, 24 kHz mono WAV intermediates, and `192k` MP3 export.
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
npx tsc --noEmit
npm run build
npm run analyze-audio -- ./path/to/file.mp3
npm run segmented-ab -- ./path/to/long-form-essay.md
```

## Environment variables

```
MISTRAL_API_KEY
MISTRAL_VOICE_ID
VOICEOVER_DEBUG_AUDIO
VOICEOVER_MASTERING_STRATEGY
VOICEOVER_CONTEXT_OVERLAP
VOICEOVER_TONE_SEAM_SCORING
VOICEOVER_SEAM_RETRIES
```

`MISTRAL_API_KEY` and `MISTRAL_VOICE_ID` are required.

Optional server-only audio diagnostics:

- `VOICEOVER_DEBUG_AUDIO=true` keeps raw, standardized, leveled, merged pre-master, final, seam-clip, and manifest debug artifacts under `/tmp` and logs file references server-side only.
- `VOICEOVER_REGENERATE_BAD_SEAMS=false` disables the default bounded bad-seam retry pass for segmented generation.
- `VOICEOVER_CONTEXT_OVERLAP=false` disables the default continuity prompt context used in segmented generation.
- `VOICEOVER_TONE_SEAM_SCORING=false` disables the default prosody/tone seam proxy scoring.
- `VOICEOVER_SEAM_RETRIES=2` controls how many bounded regeneration passes are attempted for failed seams.
- `VOICEOVER_MASTERING_STRATEGY=static` keeps the current static chain as the default.
- `VOICEOVER_MASTERING_STRATEGY=speech-leveler` enables the speech-leveler mastering experiment.
