import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src'), '@tk/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts') } },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
  },
  test: { environment: 'jsdom', include: ['tests/unit/**/*.spec.ts'], globals: true },
} as any);
