import OpenAI from 'openai';
import type {ChatClient} from './analyst.js';

/** Meta's Model API is OpenAI-compatible, so the OpenAI SDK talks to it with a different base URL. */
export const MODEL_BASE_URL = 'https://api.meta.ai/v1';

export function createChatClient(apiKey: string): ChatClient {
  // No SDK retries and a short per-call timeout: the loop's own deadline keeps a request inside
  // Vercel's maxDuration (vercel.json).
  const client = new OpenAI({apiKey, baseURL: MODEL_BASE_URL, timeout: 20_000, maxRetries: 0});
  return {create: req => client.chat.completions.create(req)};
}
