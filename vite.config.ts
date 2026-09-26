import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  appType: "spa",
  server: {
    // 开发时前端在 5173、后端在 3000。appType 是 "spa"，所以没有这条代理时
    // /api/* 会被 SPA fallback 当成路由返回 index.html，前端 res.json() 解析 HTML
    // 就会抛 "Unexpected end of JSON input"。这里把所有 /api 开头的请求转给后端。
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL("./index.html", import.meta.url)),
    },
  },
});
