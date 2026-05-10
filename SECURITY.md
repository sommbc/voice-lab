# Security Policy

Voice Lab is local-first software that handles sensitive material: bearer tokens, reference audio, exact transcripts, generated speech, and run artifacts.

## Supported Versions

Security fixes target the current `main` branch until formal releases exist.

## Reporting A Vulnerability

Use GitHub private vulnerability reporting or a private security advisory when available.

If private reporting is not available, open a minimal public issue that describes the class of issue without including secrets, private transcripts, reference audio, generated audio, private URLs, or local paths.

## Local-First Privacy Boundary

- The browser talks to the local Next.js app.
- The Next.js app talks to a local or private VoxCPM2 service.
- The app does not use hosted speech inference.
- Reference audio, exact transcripts, generated WAVs, final MP3s, and manifests should live under `VOICE_LAB_DATA_DIR` outside the repository.
- Hugging Face may be used by the Python runtime to download/cache model weights. Keep model caches outside the repository.

## Required Protections

- Do not expose the VoxCPM2 service publicly without authentication.
- Use a strong `VOXCPM_API_KEY` for the Next app and Python service.
- Prefer localhost, SSH tunnels, private networks, or authenticated HTTPS.
- Do not commit `.env.local`, voice samples, transcripts, generated audio, manifests, model caches, or temporary artifacts.
- Do not log bearer tokens, base64 audio payloads, exact transcripts, source text, or private absolute paths.

## Public Deployment Warning

The default app is designed for trusted local use. Before exposing it outside a trusted local network, add application authentication, upload limits, request size limits, rate limits, HTTPS, retention controls, abuse handling, and a storage policy.
