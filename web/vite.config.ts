import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mastraProxyTarget } from './src/dev-proxy';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: mastraProxyTarget, changeOrigin: true },
    },
  },
});
