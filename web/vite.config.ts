import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig, loadEnv, type Plugin} from 'vite';
import react from '@vitejs/plugin-react';

const webRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * Serves POST /api/analyst in `npm run dev` with the same handler Vercel deploys (api/analyst.ts),
 * loaded through ssrLoadModule so edits hot-reload. MODEL_API_KEY comes from the shell or the repo
 * root .env and stays in this server process; it is never exposed to the client bundle.
 */
function analystApi(): Plugin {
  return {
    name: 'sentinel-analyst-api',
    configureServer(server) {
      const env = loadEnv(server.config.mode, path.resolve(webRoot, '..'), '');
      if (!process.env.MODEL_API_KEY && env.MODEL_API_KEY) process.env.MODEL_API_KEY = env.MODEL_API_KEY;
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
