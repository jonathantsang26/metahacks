import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig, loadEnv, type Plugin} from 'vite';
import react from '@vitejs/plugin-react';

const webRoot = path.dirname(fileURLToPath(import.meta.url));
/** Server-only variables the dev analyst needs: the key and the spend budget (api/_lib/budget.ts),
 * whose store variables may carry a prefix (matched by suffix below). */
const SERVER_ENV = ['MODEL_API_KEY', 'ANALYST_BUDGET_USD', 'ANALYST_BUDGET_LOCAL'];

/**
 * Serves POST /api/analyst in `npm run dev` with the same handler Vercel deploys (api/analyst.ts),
 * loaded through ssrLoadModule so edits hot-reload. MODEL_API_KEY and the budget store's variables
 * come from the shell or the env files and stay in this server process, never in the client bundle.
 */
function analystApi(): Plugin {
  return {
    name: 'sentinel-analyst-api',
    configureServer(server) {
      // The repo root .env, then web/.env.local (where `vercel env pull` puts the Upstash store's variables).
      const env = {...loadEnv(server.config.mode, path.resolve(webRoot, '..'), ''), ...loadEnv(server.config.mode, webRoot, '')};
      for (const [k, v] of Object.entries(env)) {
        const wanted = SERVER_ENV.includes(k) || /(KV_REST_API_URL|KV_REST_API_TOKEN|UPSTASH_REDIS_REST_URL|UPSTASH_REDIS_REST_TOKEN)$/.test(k);
        if (wanted && v && !process.env[k]) process.env[k] = v;
      }
      server.middlewares.use('/api/analyst', async (req, res, next) => {
        try {
          const mod = await server.ssrLoadModule('/api/analyst.ts');
          await mod.default(req, res);
        } catch (e) {
          next(e);
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), analystApi()],
  server: {port: 5173}
});
