import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: { exclude: ['emf-converter'] },
  build: { rollupOptions: { external: ['emf-converter'] } },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4111',
      '/auth': 'http://127.0.0.1:4111',
      '/model-catalog': 'http://127.0.0.1:4111',
      '/user-files': 'http://127.0.0.1:4111',
      '/current-workspace': 'http://127.0.0.1:4111',
    },
  },
  test: { environment: 'jsdom', restoreMocks: true, server: { deps: { inline: ['@mastra/playground-ui'] } } },
});
