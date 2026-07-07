import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

function resolveServerPort(): number {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // 1. 优先从 backend/.port-server 文件读取后端实际监听端口
  try {
    const portFile = path.resolve(__dirname, '../backend/.port-server');
    const raw = fs.readFileSync(portFile, 'utf-8').trim();
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port > 0 && port <= 65535) {
      return port;
    }
  } catch {
    // 文件不存在或无法读取，使用后续降级来源
  }
  // 2. 降级到环境变量 XIAOMING_SERVER_PORT
  if (process.env.XIAOMING_SERVER_PORT) {
    const port = parseInt(process.env.XIAOMING_SERVER_PORT, 10);
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
    proxy: {
      '/api': {
        target: `http://localhost:${serverPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
