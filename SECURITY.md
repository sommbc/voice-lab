# Security Policy

Voice Lab is local-first software that handles sensitive inputs: API keys, reference audio, exact transcripts, generated speech, and debug artifacts.

## Supported Versions

Security fixes target the current `main` branch until formal releases exist.

## Reporting A Vulnerability

Open a private security advisory on GitHub when available. If advisories are not available, open an issue with a minimal description and omit secrets, private transcripts, reference audio, and generated audio.

## Privacy Boundaries

- `.env` must stay local.
- Provider API keys must never be exposed to browser code.
- VoxCPM2 must require bearer-token auth.
- Reference audio, transcripts, run artifacts, and debug manifests should live under `VOICE_LAB_DATA_DIR` outside the repo.
- Do not attach private audio or transcripts to public issues.

## Deployment Warning

The default app is designed for trusted local use. Before exposing it on the public internet, add authentication, upload limits, retention controls, rate limits, and a storage policy.
