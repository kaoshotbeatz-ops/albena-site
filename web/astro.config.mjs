import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

const DEFAULT_LASTMOD = '2026-10-09';
/** @type {Record<string, string>} */
const LASTMOD = {};

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
  integrations: [
    sitemap({
      filter: (page) => !new URL(page).pathname.startsWith('/admin'),
      // lastmod is the date the page's content last changed materially. Bump it when you edit a page.
      serialize: (item) => ({ ...item, lastmod: LASTMOD[new URL(item.url).pathname] ?? DEFAULT_LASTMOD }),
    }),
  ],
  vite: {
    build: { assetsInlineLimit: 0 },
  },
});
