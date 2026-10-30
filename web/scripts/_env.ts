import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_ENV = path.resolve(WEB_ROOT, '..', '.env');

/** MODEL_API_KEY from the environment, else from the repo root .env. Never printed. */
export function modelApiKey(): string | undefined {
  const fromEnv = process.env.MODEL_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(ROOT_ENV)) return undefined;
  for (const line of readFileSync(ROOT_ENV, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?MODEL_API_KEY\s*=\s*(.*?)\s*$/);
    if (m) return m[1].replace(/^(['"])(.*)\1$/, '$2').trim() || undefined;
  }
  return undefined;
}

export const NO_KEY_MESSAGE =
  'MODEL_API_KEY not set. Export it in your shell or add MODEL_API_KEY=... to the repo root .env (see .env.example). The analyst does not answer without the model.';
