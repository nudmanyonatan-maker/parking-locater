import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// PARKNEARME_LOCAL_ONLY=1 disables remote bindings (Workers AI) so `vite dev`
// works without a Cloudflare login. Analysis then reports "AI unavailable"
// unless DETECTOR=fixture is set in .dev.vars.
const localOnly = process.env.PARKNEARME_LOCAL_ONLY === '1';

export default defineConfig({
  plugins: [react(), cloudflare({ remoteBindings: !localOnly })],
  build: {
    chunkSizeWarningLimit: 700,
  },
  // Only the app's own entry; feasibility/raw/ holds saved third-party HTML pages.
  optimizeDeps: { entries: ['index.html'] },
});
