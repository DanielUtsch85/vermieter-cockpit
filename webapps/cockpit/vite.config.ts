// Vite build of the cockpit (ui-guide.md §7.1; technology.md §7.1: Vite instead of Next.js, no server rendering behind a
// login). The app lives under /cockpit on the one origin of the reverse proxy (deploy/caddy/Caddyfile, mre-integration.md
// §47.2), so it is built with that base path. The Vitest settings sit here too (Vitest in the backend's version).
import { fileURLToPath } from 'node:url';
import tailwindcss from 'tailwindcss';
import { defineConfig } from 'vitest/config';

// Local development without Caddy: the dev server is the one origin and forwards the two APIs to the loopback ports of
// docker-compose.yml, so the refresh-token cookie of the MRE authenticator (domain `localhost`) works as behind the proxy.
const proxy = {
  '/api/v1': process.env['COCKPIT_DE_URL'] ?? 'http://127.0.0.1:8090',
  '/api/v2': process.env['COCKPIT_MRE_URL'] ?? 'http://127.0.0.1:8080',
};

export default defineConfig({
  base: '/cockpit/',
  esbuild: { jsx: 'automatic' },
  css: {
    postcss: { plugins: [tailwindcss({ config: fileURLToPath(new URL('./tailwind.config.ts', import.meta.url)) })] },
  },
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, strictPort: true, proxy },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      // TanStack Query marks its modules `"use client"` for server-rendering frameworks; a Vite SPA has no server
      // components, so the directive means nothing here (Rollup drops it and warns once per module, plus a sourcemap
      // warning for locating that warning).
      onwarn(warning, warn) {
        const tanstack = warning.id?.includes('/node_modules/@tanstack/') === true;
        if (tanstack && (warning.code === 'MODULE_LEVEL_DIRECTIVE' || warning.code === 'SOURCEMAP_ERROR')) return;
        warn(warning);
      },
    },
  },
  test: { environment: 'node', include: ['src/**/*.test.{ts,tsx}'] },
});
