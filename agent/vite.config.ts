import { agentNative } from "@agent-native/core/vite";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

const reactRouterPlugins = reactRouter as unknown as () => any[];
const agentNativePlugins = agentNative as unknown as (
  options?: Parameters<typeof agentNative>[0],
) => any[];
export default defineConfig({
  optimizeDeps: {
    entries: [
      "app/entry.client.tsx",
      "app/root.tsx",
      "app/components/layout/{Layout,Sidebar}.tsx",
      "app/components/chat/ChatRouteContent.tsx",
      "app/routes/{home,chat.$threadId}.tsx",
    ],
    // The incident map (app/sentinel) loads deck.gl lazily, and agent-native turns off dependency
    // discovery, so pre-bundle deck.gl/luma.gl here or their CommonJS deps (earcut) break in dev.
    include: [
      "@deck.gl/core",
      "@deck.gl/layers",
      "@deck.gl/geo-layers",
      "@deck.gl/mesh-layers",
      "@deck.gl/extensions",
      "@deck.gl/react",
      "@luma.gl/core",
      "@luma.gl/shadertools",
    ],
    // ESM with its own wasm loading (app/sentinel/drones/live/detector.ts).
    exclude: ["onnxruntime-web"],
  },
  plugins: [
    ...reactRouterPlugins(),
    ...agentNativePlugins({
      ssrStubs: ["shiki"],
    }),
  ],
});
