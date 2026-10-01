import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  appType: "spa",
  // 静态图片（牌背 Card-back.png 等）放在 src/client/Public，而 Vite 默认的公开目录是根下的
  // "public"（小写，本项目里并不存在）。不指这一行的话，/Card-back.png 在 dev(5173) 会 404，
  // build 也不会把它复制进 dist/client（后端 express.static(dist/client) 只服务那个目录）。
  // 指过来之后：dev 里按 /Card-back.png 直接取，build 时原样复制到 dist/client 根部。
  publicDir: fileURLToPath(new URL("./src/client/Public", import.meta.url)),
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
