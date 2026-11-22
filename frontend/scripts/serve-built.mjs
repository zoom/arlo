// Serve the app the way the Zoom panel needs it: as a built bundle that is
// rebuilt whenever a source file changes.
//
// Vite's dev server sends about 170 separate modules and relies on its
// hot-reload WebSocket to keep the page consistent. Inside Zoom the page comes
// through ngrok and the backend proxy, where that WebSocket cannot connect:
// loading took about 30 seconds, and after a dependency rebuild the webview
// mixed cached modules with new ones and the app never mounted. A bundle is a
// couple of content-hashed files, so it loads fast and cannot go stale.
//
// Use `npm run dev` instead for the hot-reloading dev server in a normal browser.
import { build, preview } from 'vite';

const watcher = await build({
  build: {
    watch: {},
    sourcemap: true, // readable stack traces in the panel's DevTools
  },
});

let serving = false;
watcher.on('event', async (event) => {
  if (event.code === 'ERROR') {
    console.error('[arlo] build failed:', event.error?.message || event.error);
    return;
  }
  if (event.code !== 'END') return;
  console.log(`[arlo] build ready ${new Date().toISOString()}. Reload the Zoom panel to see changes.`);
  if (serving) return;
  serving = true;
  const server = await preview(); // host, port and allowed hosts come from vite.config.js
  server.printUrls();
});
