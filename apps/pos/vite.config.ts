import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // PGlite ships its own WebAssembly; Vite must not pre-bundle it.
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  server: { fs: { allow: ['../..'] } },
  build: { target: 'es2022' },
});
