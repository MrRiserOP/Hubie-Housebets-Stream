import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = path.resolve(import.meta.dirname);

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: path.resolve(root, '../../dist'), emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/hub': { target: 'ws://127.0.0.1:8787', ws: true },
      '/api': 'http://127.0.0.1:8787',
      '/tts': 'http://127.0.0.1:8787',
      '/assets-hubie': 'http://127.0.0.1:8787',
    },
  },
});
