/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The site is served from a project page on GitHub Pages (/grocery-pricer/) unless a custom
// domain or a user page is used, in which case BASE_PATH can override it at build time.
const base = process.env.BASE_PATH ?? '/grocery-pricer/';

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      // 'prompt', not 'autoUpdate'. autoUpdate makes the new worker seize control the moment it
      // installs, which means a reload can land in the middle of a receipt being processed. The
      // app registers the worker itself in src/ui/pwa.ts and decides when it is safe to hand
      // over - see src/ui/updates.ts.
      registerType: 'prompt',
      // The app imports virtual:pwa-register itself; injecting a second registration script
      // would register the worker twice.
      injectRegister: null,
      includeAssets: ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Grocery Pricer',
        short_name: 'Pricer',
        description: 'Turn a wholesale receipt into a conversation.',
        theme_color: '#14532d',
        background_color: '#faf9f6',
        display: 'standalone',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The app shell is cached so a saved order opens with no connection at all. Calls to
        // Gemini are deliberately never cached - a stale answer about money is worse than none.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Take charge of the page as soon as the first install finishes, so the app works
        // offline from the first visit rather than the second.
        clientsClaim: true,
        // But never seize control from a page that is already running: a new worker waits until
        // the app says the moment is safe. That handover is src/ui/updates.ts.
        skipWaiting: false,
        navigateFallback: `${base}index.html`,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/generativelanguage\.googleapis\.com\/.*/,
            handler: 'NetworkOnly',
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
