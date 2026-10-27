// Small client for Groq's OpenAI-compatible API: JSON chat, speech-to-text and text-to-speech.

const BASE = 'https://api.groq.com/openai/v1';

export class GroqError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function createGroqClient({
  apiKey,
  model = 'openai/gpt-oss-120b',
  sttModel = 'whisper-large-v3-turbo',
  ttsModel = 'canopylabs/orpheus-v1-english',
  fetchImpl = fetch,
  timeoutMs = 25_000,
}) {
  // Retries once when the connection fails; HTTP errors are reported as-is.
  async function send(path, init) {
    const attempt = () => fetchImpl(BASE + path, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, ...init.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    let res;
    try {
      res = await attempt();
    } catch {
      try {
        res = await attempt();
      } catch {
        throw new GroqError('Could not reach the AI service', 'network_error', 503);
      }
    }
    if (init.raw && res.ok) return Buffer.from(await res.arrayBuffer());
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new GroqError(json.error?.message || `AI request failed (${res.status})`, json.error?.code || 'ai_error', res.status);
    }
    return json;
  }

  // Sends a chat and returns the reply parsed as JSON.
  async function chatJSON(messages, { temperature = 0.3 } = {}) {
    const json = await send('/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        reasoning_effort: 'low',
        response_format: { type: 'json_object' },
      }),
    });
    const text = json.choices?.[0]?.message?.content ?? '';
    try {
      return JSON.parse(text);
    } catch {
      throw new GroqError('The AI reply was not valid JSON', 'bad_ai_reply', 502);
    }
  }

  // Turns a short voice recording into text.
  async function transcribe(buffer, mimeType = 'audio/webm') {
    const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : 'webm';
    const form = new FormData();
    form.append('model', sttModel);
    form.append('language', 'en');
    form.append('file', new Blob([buffer], { type: mimeType }), `voice.${ext}`);
    const json = await send('/audio/transcriptions', { method: 'POST', body: form });
    return (json.text || '').trim();
  }

  // Turns up to 200 characters of text into natural speech (WAV).
  async function speak(text, voice) {
    return send('/audio/speech', {
      method: 'POST',
      raw: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: ttsModel, input: text, voice, response_format: 'wav' }),
    });
  }

  return { model, chatJSON, transcribe, speak };
}
