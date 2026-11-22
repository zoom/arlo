import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server runs in Docker as `frontend:3000` and is reached through the
// backend proxy (ngrok → backend → here), never directly from the internet.
const extraHosts = (process.env.VITE_ALLOWED_HOSTS || '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    // Vite rejects unknown Host headers. The backend proxy sends `frontend:3000`.
    allowedHosts: ['frontend', ...extraHosts],
    // The backend proxy does not forward WebSockets (it owns /ws), so hot reload
    // cannot connect through it. Opt in when developing on the dev server directly.
    hmr: process.env.VITE_HMR === 'true',
    watch: {
      usePolling: process.env.VITE_USE_POLLING === 'true',
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
  },
  build: {
    // Same folder CRA used: the backend serves it when present, and deploy
    // scripts run `serve -s build`.
    outDir: 'build',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    css: false,
  },
});
