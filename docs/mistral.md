# Mistral Voxtral

The Mistral provider is the default TTS path in Voice Lab.

## Setup

Set these in `.env`:

```bash
MISTRAL_API_KEY=
MISTRAL_VOICE_ID=your-default-voice-id
```

`MISTRAL_VOICE_ID` is optional only if you enter a voice ID in the UI for each run.

## Behavior

- The app sends provider requests from the server only.
- The default route attempts one full-document request first.
- Segmented fallback is used only when the continuous request fails for a reason likely related to size, timeout, or provider availability.
- Segmented mode can also be forced from the UI for diagnostics.
- Final output is mastered locally after provider audio is returned.

## Limitations

- Provider voice IDs are not shipped with Voice Lab.
- Long input behavior depends on provider limits and current model behavior.
- Segmented fallback improves control and diagnostics but can still produce audible joins.
- Seam scoring identifies likely problem areas; it does not prove the result is subjectively seamless.

## Relevant Env Vars

- `MISTRAL_API_KEY`
- `MISTRAL_VOICE_ID`
- `VOICE_LAB_CONTEXT_OVERLAP`
- `VOICE_LAB_TONE_SEAM_SCORING`
- `VOICE_LAB_SEAM_RETRIES`
- `VOICE_LAB_MULTI_TAKE_COUNT`
- `VOICE_LAB_MASTERING_STRATEGY`
