Found 6 actionable issues, most severe first. No files were edited.

1. **High — Production build always embeds Cloudflare’s always-pass Turnstile test key**  
   [web/src/components/Turnstile.astro:2](web/src/components/Turnstile.astro:2), [.github/workflows/ci.yml:46](.github/workflows/ci.yml:46)  
   CI never supplies `PUBLIC_TURNSTILE_SITE_KEY`, so Astro uses `1x00000000000000000000AA`. With a production secret, every submission fails; using the matching test secret makes Turnstile bypassable.  
   **Fix:** Remove the fallback, fail the build when the variable is absent/test-valued, and map a GitHub production variable into the build job.

2. **High — Mutable CI dependencies execute in the production deployment chain**  
   [.github/workflows/ci.yml:151](.github/workflows/ci.yml:151), [.github/workflows/ci.yml:155](.github/workflows/ci.yml:155), [.github/workflows/ci.yml:121](.github/workflows/ci.yml:121)  
   Actions use mutable tags such as `@v4`, and Semgrep uses `:latest`. A compromised/moved action tag in the deploy job can modify the runner before the Cloudflare token is exposed at line 171.  
   **Fix:** Pin every action to a reviewed full commit SHA and container image to a digest; update them through controlled Dependabot PRs.

3. **Medium — Turnstile tokens are not bound to the expected hostname or operation**  
   [worker/src/util.ts:48](worker/src/util.ts:48)  
   Verification accepts any response with `success: true`, ignoring `hostname` and `action`. A token minted from another permitted hostname or form using the same widget can be used here.  
   **Fix:** Set distinct `action` values when rendering each form and require the Siteverify response to contain `hostname === "albena.ai"` and the expected action.

4. **Medium — PII writes and audit records are not atomic**  
   [worker/src/public.ts:93](worker/src/public.ts:93), [worker/src/public.ts:112](worker/src/public.ts:112)  
   The waitlist/ticket row is committed before `audit_log` is written. If auditing fails, PII remains stored without the promised audit record; support returns 500, encouraging retries that create duplicate tickets.  
   **Fix:** Commit the business row and audit row in one D1 atomic batch/transaction. Generate the ticket identifier before the batch if necessary.

5. **Medium — The CI header gate accepts ineffective or dangerously permissive CSPs**  
   [scripts/check-headers.sh:29](scripts/check-headers.sh:29), [.github/workflows/ci.yml:34](.github/workflows/ci.yml:34)  
   It only checks that `default-src` or `script-src` appears and rejects only `unsafe-eval`. It accepts `script-src * 'unsafe-inline'`; its own “good” fixture uses invalid unquoted `self` and `none`.  
   **Fix:** Require exact effective directives such as `default-src 'none'`, prohibit wildcards/`'unsafe-inline'`/`'unsafe-eval'`, and require `frame-ancestors 'none'`, `object-src 'none'`, and `base-uri 'none'`.

6. **Low — Request-size limit measures characters after buffering the entire body**  
   [worker/src/public.ts:48](worker/src/public.ts:48)  
   `text.length` is UTF-16 character count, not request bytes, and the full body is already in memory before rejection. Multi-byte payloads can exceed the stated 16 KiB cap substantially.  
   **Fix:** Reject oversized `Content-Length` early, then enforce an actual byte limit while reading the body.

I did not find a credible Access JWT bypass, SQL injection, CSV formula injection, or browser CSRF exploit. Tests could not execute under the mandated read-only sandbox because Vitest attempted to create `node_modules/.vite-temp`; static review and existing built-output inspection were completed.