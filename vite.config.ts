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
        // 游戏目录与 MCEF/Chromium 运行缓存不该被监听：里面全是频繁创建、
        // 占用、重命名、删除的 .tmp 与 Code Cache/Network 文件，监听它们
        // 对开发毫无用处，Windows 上还会不断抛出
        // "EBUSY: resource busy or locked, watch ..."。
        "**/.minecraft/**",
        "**/mcef-cache/**",
        "**/Code Cache/**",
        "**/GPUCache/**",
        "**/ShaderCache/**",
        "**/DawnCache/**",
        "**/CachedData/**",
        "**/Network/**",
        "**/*.tmp",
      ],
    },
  },
}));
