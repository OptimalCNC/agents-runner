import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/events": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../public",
    emptyOutDir: true,
    // Review diff rendering pulls in a large optional dependency graph.
    // It's lazy-loaded behind the Review tab, so raise the warning limit
    // to avoid noisy warnings for that async-only chunk.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }

          // Keep all review/diff ecosystem in one async vendor chunk to avoid
          // circular chunking between interdependent subpackages.
          if (id.includes("@git-diff-view/") || id.includes("highlight.js") || id.includes("lowlight")) {
            return "review-vendor";
          }

          return undefined;
        },
      },
    },
  },
});
