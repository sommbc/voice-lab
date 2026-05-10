# Privacy

Voice Lab handles private audio, exact transcripts, source text, generated narration, and bearer tokens. Treat the default app as trusted local software unless you add a real public security layer.

## Stored Locally

By default, private artifacts live under `~/.voice-lab`, or under `VOICE_LAB_DATA_DIR` when configured:

- reference audio
- exact reference transcripts
- generated WAV sections
- final MP3 files
- run manifests
- upload temp files during request handling

## Manifest Rules

Run manifests should contain hashes, filenames, metrics, run IDs, and settings. They should not contain raw source text, exact transcripts, base64 audio, bearer tokens, or private absolute paths.

## Git Hygiene

The repo ignores local env files, generated audio formats, local storage folders, build output, and temporary artifacts. Before publishing, run the release checklist and verify no private audio, transcripts, manifests, paths, or URLs are tracked.

## Public Deployment Warning

Before exposing Voice Lab outside a trusted local network, add authentication, upload limits, retention controls, rate limits, HTTPS, and an explicit storage policy.
