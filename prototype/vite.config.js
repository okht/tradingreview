import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(async () => process.env.HUIKAN_CLOUD === '1' ? (await import('./vite.cloud.config.ts')).default : { plugins: [react()], server: { proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } } }, build: { outDir: 'dist-local' } });
