import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://albena.ai',
  output: 'static',
  outDir: './dist',
  trailingSlash: 'never',
  build: {
    format: 'file',
    // CSP is script-src 'self' https://challenges.cloudflare.com: never inline CSS/JS.
    inlineStylesheets: 'never',
  },
  integrations: [sitemap()],
  vite: {
    build: { assetsInlineLimit: 0 },
  },
});
