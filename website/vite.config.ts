import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 每次构建烙一个时间戳进 bundle，让入口 bundle 的内容哈希**每次部署都变**。
  // 为什么要这样：mrday.one 前面是 Cloudflare，资源 URL 被边缘缓存。2026-09-07 一次部署撞上并发
  // 部署，index.html 指向的 bundle 那一瞬不在盘上，边缘把这个 404 缓存住了——文件随后补上也没用，
  // 因为 URL 没变、边缘照旧回 404，整站白屏。哈希每次都变，重新部署就是一个全新的 URL，旧的
  // 缓存条目再也不会被引用。代价是每次部署用户重下一次入口 bundle（120KB gzip），本来也如此。
  define: { __SITE_BUILD__: JSON.stringify(new Date().toISOString()) },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5273,
    strictPort: true,
  },
});
