import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_ENV = path.resolve(WEB_ROOT, '..', '.env');
/** Where `vercel env pull` writes the project's variables (the Upstash store's among them). */
const PULLED_ENV = path.resolve(WEB_ROOT, '.env.local');

function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  return out;
}

/**
 * The environment the CLI scripts run with: the repo root .env, then web/.env.local, then the shell
 * (which wins). Values are never printed.
 */
export function localEnv(): Record<string, string | undefined> {
  return {...readEnvFile(ROOT_ENV), ...readEnvFile(PULLED_ENV), ...process.env};
}

/** MODEL_API_KEY from the environment, else from the repo root .env or web/.env.local. Never printed. */
export function modelApiKey(): string | undefined {
  return localEnv().MODEL_API_KEY?.trim() || undefined;
}

export const NO_STORE_HINT =
  'The Meta key spends against the analyst budget. Run `vercel env pull` in web/ to get the Upstash store variables into web/.env.local, or set ANALYST_BUDGET_LOCAL=1 for an untracked local run.';

export const NO_KEY_MESSAGE =
  'MODEL_API_KEY not set. Export it in your shell or add MODEL_API_KEY=... to the repo root .env (see .env.example). The analyst does not answer without the model.';
