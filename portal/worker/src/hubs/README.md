# Hubs module (pairing, signed heartbeat, releases)

Merge notes
- `index.ts` exports `mount(app)` and `migrations`. Replace imports from `./_stubs` with `../auth` (requireUser, audit, AppEnv)
  and billing (`getEntitlement(c, accountId) -> {maxHubs}`; stub signature assumed). Delete `_stubs.ts`.
- Optional secret `HUB_CODE_PEPPER` (peppers the stored pair-code hash). Rate limit uses `cf-connecting-ip`.
- If portal/worker has no package.json yet: run tests from `portal/worker/hubs-dev` (`npm i && npm test && npm run typecheck`,
  Node 24). It uses a node:sqlite D1 shim; after merge switch tests to @cloudflare/vitest-plugin and drop `hubs-dev/`.
- Signed request format: headers X-Hub-Id, X-Hub-Timestamp (unix s, +-300s), X-Hub-Signature = base64 Ed25519 over
  `METHOD\nPATH+QUERY\nTS\nsha256hex(body)`. Replay cache: `hub_nonces` (sha256 of signature, TTL 600s). Cron/alarm should
  also prune `hub_nonces`/`hub_rate`/expired `hub_pair_codes`; nonces are pruned opportunistically per request.
- Releases: table `releases` is read-only here. Adding a release is an ADMIN operation, out of scope: insert a row per release
  after `hub/update/make-release.sh` (manifest_url, signature_url, signature = ssh signature text, sha256 = sha256 of
  manifest.json). The API is only a pointer; clients verify the manifest against `hubconf/release-signers` (hub/update/KEYS.md).
  Stable never serves beta; beta gets the newest of beta/stable.
- Contract deviation: pair/complete returns `{hubId}` only (no `token`), per task: hub auth is request signing.
- Known limits: pair/complete rate limit is per IP (fixed window, D1); entitlement is checked at pair/start only.
