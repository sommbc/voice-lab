export const MISTRAL_SPEECH_ENDPOINT = "https://api.mistral.ai/v1/audio/speech";
export const MISTRAL_MODEL = "voxtral-mini-tts-2603";

export async function postMistralSpeech({
  input,
  voiceId,
  responseFormat,
  timeoutMs
}: {
  input: string;
  voiceId: string;
  responseFormat: "mp3" | "wav";
  timeoutMs: number;
}): Promise<Response> {
  return await fetch(MISTRAL_SPEECH_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MISTRAL_MODEL,
      input,
      voice_id: voiceId,
      response_format: responseFormat,
      stream: false
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
}

export async function parseMistralAudioResponse(response: Response): Promise<Buffer> {
  let data: { audio_data?: string };

  try {
    data = (await response.json()) as { audio_data?: string };
  } catch {
    throw new Error("Mistral API response was not valid JSON.");
  }

  if (!data.audio_data) {
    throw new Error("Mistral API response did not include audio_data.");
  }

  return Buffer.from(data.audio_data, "base64");
}
