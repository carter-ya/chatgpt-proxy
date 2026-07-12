import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

function resolveServerPort(): number {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // 1. 优先从项目根目录 .port-server 文件读取后端实际监听端口。
  const portFiles = [
    path.resolve(__dirname, '../.port-server'),
    path.resolve(__dirname, '../backend/.port-server'),
  ];
  for (const portFile of portFiles) {
    try {
      const raw = fs.readFileSync(portFile, 'utf-8').trim();
      const port = parseInt(raw, 10);
      if (!isNaN(port) && port > 0 && port <= 65535) {
        return port;
      }
    } catch {
      // 文件不存在或无法读取，继续尝试后续来源。
    }
  }
  // 2. 降级到环境变量 CHATGPT_PROXY_SERVER_PORT
  if (process.env.CHATGPT_PROXY_SERVER_PORT) {
    const port = parseInt(process.env.CHATGPT_PROXY_SERVER_PORT, 10);
    if (!isNaN(port) && port > 0 && port <= 65535) {
      return port;
    }
  }
  // 3. 最终默认值
  return 8080;
}

const serverPort = resolveServerPort();

export default defineConfig({
  plugins: [react()],
  server: {
    ...(process.env.PORT ? { port: Number(process.env.PORT) } : {}),
    allowedHosts: ['chatgpt-proxy.theledgers.org'],
    proxy: {
      '/api': {
        target: `http://localhost:${serverPort}`,
        changeOrigin: true,
      },
    },
  },
  preview: {
    allowedHosts: ['chatgpt-proxy.theledgers.org'],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
