import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    ...(process.env.PORT ? { port: Number(process.env.PORT) } : {}),
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.XIAOMING_SERVER_PORT || 8080}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
