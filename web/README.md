# albena.ai web (Astro, static)

    export PATH="$(brew --prefix node@24)/bin:$PATH"
    npm install
    npm run build      # astro check + build -> dist/
    npx astro preview --port 4388

- Turnstile site key: `PUBLIC_TURNSTILE_SITE_KEY` (falls back to the Cloudflare test key). See `.env.example`.
- Forms POST JSON to `/api/waitlist` and `/api/support` with `turnstileToken`; honeypot field `website` is never sent.
- Controls table data: `src/data/controls.json` (validated at build by `src/data/controls.ts`).
- Output is CSP-friendly: no inline scripts or styles (`script-src 'self' https://challenges.cloudflare.com`).
