import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    ...(process.env.PORT ? { port: Number(process.env.PORT) } : {}),
    ...(process.env.VITE_API_TARGET
      ? {
          proxy: {
            '/api': {
              target: process.env.VITE_API_TARGET,
              changeOrigin: true,
            },
          },
        }
      : {}),
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
