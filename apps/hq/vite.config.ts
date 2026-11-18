import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the console talks to a MedFlow HQ server on port 5299.
export default defineConfig({
  plugins: [react()],
  server: { fs: { allow: ['../..'] }, proxy: { '/hq/': 'http://localhost:5299' } },
  build: { target: 'es2022' },
});
