# SEO and AI-citation runbook (for Omar)

Site: https://albena.ai. Sitemap: https://albena.ai/sitemap-index.xml. Robots: allows search and AI crawlers.

## 1. Google Search Console (domain property, DNS TXT via Cloudflare)

1. Open https://search.google.com/search-console and choose Add property -> Domain -> `albena.ai`.
2. Google shows a TXT value like `google-site-verification=XXXX`. Copy it.
3. Cloudflare dashboard -> albena.ai -> DNS -> Records -> Add record: Type `TXT`, Name `@`, Content = the value, TTL Auto. Save. (Or ask the lead to add it with the Cloudflare tool.)
4. Back in Search Console press Verify (may take a few minutes).
5. Sitemaps -> add `sitemap-index.xml` -> Submit. Status should read Success with 17 or more discovered pages.
6. URL Inspection -> paste `https://albena.ai/` -> Request indexing. Repeat for `/faq`, `/compare`, `/hardware`.

## 2. Bing Webmaster Tools

1. https://www.bing.com/webmasters -> Add site -> `https://albena.ai`. Fastest: Import from Google Search Console (after step 1).
2. Otherwise choose DNS verification: Bing gives a CNAME record. In Cloudflare add Type `CNAME`, Name = the host Bing shows (like `abc123`), Target = the value Bing shows, Proxy status DNS only.
3. Sitemaps -> submit `https://albena.ai/sitemap-index.xml`.
4. Settings -> IndexNow: it should show the key `2c31ce1ebcc8c305b56c1fbc1f388a6a` as verified after the first deploy ping.

Bing powers results for ChatGPT search, Copilot and DuckDuckGo, so Bing indexing matters for AI citations.

## 3. IndexNow (already implemented)

- Key file: `web/public/2c31ce1ebcc8c305b56c1fbc1f388a6a.txt`, served at `https://albena.ai/2c31ce1ebcc8c305b56c1fbc1f388a6a.txt`. The key is public by design.
- Ping: `scripts/indexnow.mjs` posts every sitemap URL to `api.indexnow.org` (Bing, Yandex, Seznam, Naver). CI runs it after each production deploy (`continue-on-error`, never blocks a deploy).
- Manual: `cd web && npm run build && cd .. && node scripts/indexnow.mjs` (add `--dry-run` to preview). Google does not use IndexNow.
- To rotate the key: generate 32 hex chars, rename the key file and update `KEY` in the script.

## 4. After each content change

- Update the page, bump `LASTMOD` for that path in `web/astro.config.mjs` (default is 2026-10-09), update `docs/competitive.md` and the `/compare` "Last verified" date if competitor facts were rechecked.
- `cd web && npm run build && npm run seo:check` must pass (titles <= 60, descriptions <= 155, one H1, canonical, OG image, JSON-LD parses, internal links resolve, sitemap).
- Validate structured data before big changes: https://validator.schema.org and Google Rich Results Test on `/faq`, `/hardware`, `/`.

## 5. Tracking AI citations monthly (30 minutes, first week of the month)

1. Keep a fixed prompt list (copy into a sheet, same wording every month):
   - private home AI assistant
   - local AI assistant that runs on a Mac
   - self-hosted AI assistant NVIDIA
   - AI assistant that controls Home Assistant
   - personal AI with approvals before it acts
   - alternative to Alexa for privacy, local
   - on-device AI assistant for an estate or small business
   - Albena vs Aldena / Albena vs Home Assistant Assist
   - what is Albena AI
2. Run each in ChatGPT (with search), Claude (with web search), Perplexity, Gemini and Google (AI Overviews). Use a logged-out or fresh session where possible.
3. Record per prompt and engine: cited albena.ai (Y/N), which URL, mentioned without link (Y/N), accuracy of the claims (flag any wrong price, certification or availability), competitors cited.
4. Cross-check Search Console (Performance -> Queries, Pages) and Bing Webmaster (Search Performance; AI Performance report where available) for impressions on the same queries.
5. Server side: in Cloudflare Analytics -> Traffic, filter user agents containing `GPTBot`, `OAI-SearchBot`, `ChatGPT-User`, `ClaudeBot`, `Claude-User`, `PerplexityBot`, `Google-Extended` to confirm crawling. The site sets no analytics cookies, so do not add trackers for this.
6. Act: if an engine states something wrong, fix the source page and `llms.txt`/FAQ wording (answer-first, one fact per sentence); if a query is never cited, strengthen the mapped page per `docs/seo-keywords.md`.
7. Log the result with `ailog add claude "SEO/AEO monthly: ..."`.

## 6. Things that need a human

- DNS TXT/CNAME records and the Search Console and Bing verifications above.
- Real `sameAs` profiles (LinkedIn, GitHub, etc.) once they exist: add to `organization.sameAs` in `web/src/data/seo.ts`. None are invented today.
- When prices and availability are set: update Offer in `web/src/data/seo.ts` (add `price`, `priceCurrency`, change availability) and the FAQ/`llms.txt`.
