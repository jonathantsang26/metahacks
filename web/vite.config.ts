import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defaultClientConditions, defineConfig, loadEnv, type Plugin} from 'vite';
import react from '@vitejs/plugin-react';

const webRoot = path.dirname(fileURLToPath(import.meta.url));
/** Server-only variables the dev analyst needs: the key and the spend budget (api/_lib/budget.ts),
 * whose store variables may carry a prefix (matched by suffix below). */
const SERVER_ENV = ['MODEL_API_KEY', 'ANALYST_BUDGET_USD', 'ANALYST_BUDGET_LOCAL', 'SAM_DAILY_BUDGET_USD'];

/**
 * Serves POST /api/analyst and /api/sam in `npm run dev` with the same handlers Vercel deploys (api/*.ts),
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
      for (const route of ['analyst', 'sam']) {
        server.middlewares.use(`/api/${route}`, async (req, res, next) => {
          try {
            const mod = await server.ssrLoadModule(`/api/${route}.ts`);
            await mod.default(req, res);
          } catch (e) {
            next(e);
          }
        });
      }
    }
  };
}

/**
 * LIVE mode runs Sentinel with onnxruntime-web; its WebAssembly runtimes are copied from node_modules
 * into public/ort/ (served at /ort/, set as ort.env.wasm.wasmPaths) so nothing loads from a CDN.
 * Plain SIMD for the WASM backend, asyncify for WebGPU. public/ort/ is generated, not committed.
 * The `onnxruntime-web-use-extern-wasm` condition picks the builds that load their runtime from
 * wasmPaths instead of having Vite emit a second copy of each .wasm into assets/.
 */
const ORT_FILES = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.mjs'];
function ortWasm(): Plugin {
  return {
    name: 'sentinel-ort-wasm',
    configResolved() {
      const from = path.join(webRoot, 'node_modules/onnxruntime-web/dist');
      const to = path.join(webRoot, 'public/ort');
      fs.mkdirSync(to, {recursive: true});
      for (const f of ORT_FILES) {
        const src = path.join(from, f);
        const dst = path.join(to, f);
        if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size) fs.copyFileSync(src, dst);
      }
    },
    // In dev, Vite refuses to let source import() a file from public/ (the runtime loads its .mjs glue
    // that way), so serve /ort/ directly, ahead of Vite's transform middleware.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.match(/^\/ort\/([^?]+)/)?.[1];
        if (!name || !ORT_FILES.includes(name)) return next();
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        fs.createReadStream(path.join(webRoot, 'public/ort', name)).pipe(res);
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), analystApi(), ortWasm()],
  resolve: {conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions]},
  optimizeDeps: {exclude: ['onnxruntime-web']},
  server: {port: 5173}
});
