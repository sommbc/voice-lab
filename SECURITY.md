# Security Policy

Voice Lab is local-first software that handles sensitive inputs: bearer tokens, reference audio, exact transcripts, generated speech, and run artifacts.

## Supported Versions

Security fixes target the current `main` branch until formal releases exist.

## Reporting A Vulnerability

Open a private security advisory on GitHub when available. If advisories are not available, open an issue with a minimal description and omit secrets, private transcripts, reference audio, and generated audio.

## Privacy Boundaries

- `.env.local` must stay local.
- VoxCPM2 must require bearer-token auth.
- Reference audio, transcripts, run artifacts, and manifests should live under `VOICE_LAB_DATA_DIR` outside the repo.
- Do not attach private audio or transcripts to public issues.
- Do not log bearer tokens, base64 audio payloads, exact transcripts, or source text.

## Deployment Warning

The default app is designed for trusted local use. Before exposing it on the public internet, add authentication, upload limits, retention controls, rate limits, HTTPS, and a storage policy.
