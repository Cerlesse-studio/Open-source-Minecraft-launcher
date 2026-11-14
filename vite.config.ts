import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium108CssCompatPlugin } from "./src/lib/cssCompat.ts";

export default defineConfig(() => ({
  plugins: [react(), tailwindcss(), chromium108CssCompatPlugin()],

  build: {
    target: "chrome108",
    cssTarget: "chrome108",
    sourcemap: false,
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("react-dom") || id.includes("/react/")) {
              return "vendor-react";
            }
            if (id.includes("radix-ui") || id.includes("sonner")) {
              return "vendor-ui";
            }
            if (id.includes("lucide-react")) {
              return "vendor-icons";
            }
          }
          return undefined;
        },
      },
    },
  },

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/data/**",
        "**/.minecraft/**",
        "**/release/**",
        "**/dist/**",
      ],
    },
  },
}));
