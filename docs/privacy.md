# Privacy

Voice Lab handles private audio, exact transcripts, source text, generated narration, run manifests, model-cache metadata, and bearer tokens. Treat the default app as trusted local software unless you add a real public security layer.

## What Stays Local

By default, private artifacts live under `~/.voice-lab`, or under `VOICE_LAB_DATA_DIR` when configured:

- reference audio
- exact reference transcripts
- reference metadata with filenames, hashes, byte counts, and timestamps
- generated WAV sections
- final MP3 files
- run manifests
- upload temp files during request handling

The app does not use hosted speech inference. The configured VoxCPM2 endpoint should be local or private.

## What Goes To The Local/Private Service

During generation, the Next app sends the private VoxCPM2 service:

- target text for the current segment
- reference audio as an audio data URI
- optional prompt audio from the previous generated section
- optional prompt text
- generation settings such as CFG, inference steps, normalize, and denoise

This is why the service must be trusted, private, and authenticated.

## Manifest Rules

Run manifests should contain hashes, filenames, metrics, run IDs, settings, and timestamps. They should not contain raw source text, exact transcripts, base64 audio, bearer tokens, or private absolute paths.

Reference metadata follows the same rule: it stores original filename, original MIME type, byte size, canonical filename, hashes, character count, and update time, but not transcript contents or base64 audio.

## Hugging Face Cache Boundary

The Python runtime may download/cache VoxCPM2 model weights through Hugging Face tooling. Keep `HF_HOME` and `HF_HUB_CACHE` outside this repository. Do not commit model weights or cache contents.

## Public Exposure Risk

If you deploy the app or service publicly without adding more controls, you can expose:

- voice samples
- exact transcripts
- generated speech
- source text
- bearer-token-protected endpoints
- local file paths through weak error handling
- large upload and generation surfaces

Before public deployment, add application auth, upload limits, request size limits, rate limits, HTTPS, retention controls, abuse handling, and a storage policy.

## Git Hygiene

Do not commit:

- `.env`, `.env.local`, or real secrets
- reference audio
- transcripts
- generated WAV/MP3 files
- run manifests
- temp upload folders
- `.next`, `.vercel`, or build output
- Hugging Face/model caches
- `.DS_Store` or local metadata

Before publishing, run the release checklist and verify no private audio, transcripts, manifests, paths, tokens, or private URLs are tracked.
