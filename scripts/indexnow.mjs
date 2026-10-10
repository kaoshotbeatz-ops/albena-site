#!/usr/bin/env node
// Pings IndexNow (Bing, Yandex, Seznam, Naver) with every URL in the built sitemap.
// The key is public by design: it is served at https://albena.ai/<key>.txt so engines can verify ownership.
// Usage: node scripts/indexnow.mjs [--dry-run] [--sitemap web/dist/sitemap-0.xml]
import { readFileSync, existsSync } from 'node:fs';

const KEY = '2c31ce1ebcc8c305b56c1fbc1f388a6a';
const HOST = 'albena.ai';
const ENDPOINT = 'https://api.indexnow.org/IndexNow';
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const smIdx = args.indexOf('--sitemap');
const sitemap = smIdx >= 0 ? args[smIdx + 1] : new URL('../web/dist/sitemap-0.xml', import.meta.url).pathname;
const keyFile = new URL(`../web/public/${KEY}.txt`, import.meta.url).pathname;

if (!existsSync(sitemap)) { console.error(`sitemap not found: ${sitemap} (build the site first)`); process.exit(1); }
if (!existsSync(keyFile) || readFileSync(keyFile, 'utf8').trim() !== KEY) { console.error(`key file web/public/${KEY}.txt missing or wrong`); process.exit(1); }

const urlList = [...readFileSync(sitemap, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((u) => new URL(u).hostname === HOST);
if (!urlList.length) { console.error('no URLs found in sitemap'); process.exit(1); }

const body = { host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList };
console.log(`IndexNow: ${urlList.length} URLs for ${HOST}${dry ? ' (dry run, not sent)' : ''}`);
if (dry) { console.log(JSON.stringify(body, null, 2)); process.exit(0); }

const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
console.log(`IndexNow response: HTTP ${res.status}`);
// 200 OK and 202 Accepted (key validation pending) are both success.
if (res.status !== 200 && res.status !== 202) { console.error(await res.text().catch(() => '')); process.exit(1); }
