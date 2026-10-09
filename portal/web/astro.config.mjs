import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://account.albena.ai',
  output: 'static',
  outDir: './dist',
  trailingSlash: 'never',
  build: {
    format: 'file',
    // CSP is script-src 'self' https://challenges.cloudflare.com: never inline CSS/JS.
    inlineStylesheets: 'never',
  },
  vite: { build: { assetsInlineLimit: 0 } },
});
