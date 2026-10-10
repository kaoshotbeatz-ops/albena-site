#!/usr/bin/env node
// Build guard for the portal (account.albena.ai). Fails loudly instead of letting a partial dist ship.
//   node portal/scripts/check-portal-build.mjs ci       dist has the expected pages and a site key baked in (test key allowed)
//   node portal/scripts/check-portal-build.mjs deploy   same, plus PUBLIC_TURNSTILE_SITE_KEY must be set, real, and match the dist
// Background: a deploy once shipped dist built without PUBLIC_TURNSTILE_SITE_KEY and /login, /, /invite returned 404.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "deploy";
if (!["ci", "deploy"].includes(mode)) { console.error("usage: check-portal-build.mjs ci|deploy"); process.exit(2); }

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");
const TEST_KEYS = new Set(["1x00000000000000000000AA", "2x00000000000000000000AB", "3x00000000000000000000FF", "1x00000000000000000000BB", "2x00000000000000000000BB"]);
// astro build.format = "file": /login -> login.html. Pages that must exist; the first three are the ones that 404'd.
const PAGES = ["index.html", "login.html", "invite.html"];
const KEY_PAGES = ["login.html", "invite.html"]; // render the Turnstile widget
const errors = [];
const fail = (m) => errors.push(m);

const envKey = process.env.PUBLIC_TURNSTILE_SITE_KEY ?? "";
if (mode === "deploy") {
  if (!envKey) fail("PUBLIC_TURNSTILE_SITE_KEY is not set (set repo variable TURNSTILE_SITE_KEY / export it before building and deploying).");
  else if (TEST_KEYS.has(envKey)) fail("PUBLIC_TURNSTILE_SITE_KEY is a Cloudflare test key; refusing to deploy.");
  if (process.env.ALBENA_ALLOW_TEST_TURNSTILE === "1") fail("ALBENA_ALLOW_TEST_TURNSTILE=1 is set; it must not be set for a deploy.");
}

if (!existsSync(root) || !statSync(root).isDirectory()) {
  fail(`dist not found at ${root}; run the portal web build first.`);
} else {
  for (const p of PAGES) {
    const f = join(root, p);
    if (!existsSync(f) || statSync(f).size < 200) fail(`dist is missing or has an empty page: ${p}`);
  }
  for (const p of KEY_PAGES) {
    const f = join(root, p);
    if (!existsSync(f)) continue;
    const m = /data-sitekey="([^"]*)"/.exec(readFileSync(f, "utf8"));
    if (!m || !m[1]) { fail(`${p} has no Turnstile data-sitekey (site key missing at build time).`); continue; }
    if (mode === "deploy") {
      if (TEST_KEYS.has(m[1])) fail(`${p} was built with a Cloudflare test Turnstile key.`);
      else if (envKey && m[1] !== envKey) fail(`${p} site key does not match PUBLIC_TURNSTILE_SITE_KEY; rebuild with the current value.`);
    }
  }
}

if (errors.length) {
  for (const e of errors) console.error(`::error title=Portal build guard::${e}`);
  console.error(`Portal build guard FAILED (${mode}): ${errors.length} problem(s).`);
  process.exit(1);
}
console.log(`Portal build guard OK (${mode}): ${PAGES.join(", ")} present, Turnstile site key baked in.`);
