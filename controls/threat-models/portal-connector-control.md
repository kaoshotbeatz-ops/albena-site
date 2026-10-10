## Summary

This is the Phase 2 design for managing Hub connectors from the portal. The portal can **relay** commands but can never **authorize** them, and it never holds a usable secret.

The brief's model has a gap: **a passkey signature alone does not stop a fully compromised portal.** The attacker would control the code served at `account.albena.ai`. When the real customer next does a passkey ceremony, that code can swap in a different command, and the signature will still be valid for the correct origin. So the design splits two jobs:
- **The passkey proves the user was there.** No command can exist without a live user ceremony.
- **The Hub proves what is being approved.** For every command that adds privilege, the Hub shows the decoded command on a screen the portal does not serve (Hub panel, Albena app or voice) and the user approves it there.

Three existing gaps need fixing first:
- **The portal can already change a Hub setting.** The heartbeat response carries `remoteAccess`, and the Hub has no signature to check it against.
- **The Hub has an auto-run shortcut.** `trusted()` in `approvals.py` would skip approval, so portal commands must never use it.
- **Every key the browser handles comes from the portal.** That includes the Hub's encryption key, so client-side encryption only protects against a portal that is read or leaked, not one whose code has been replaced.

---

## 1. Threat model (STRIDE)

**What we protect, most important first**
1. Each Hub's connector credentials (OAuth refresh tokens, API keys, MCP tokens).
2. The right to change a connector (connect, add write access, add an MCP server or tool).
3. Home data reached through connectors.
4. The list of passkey keys each Hub trusts (the "trust root").
5. Hub identity keys (Ed25519 for signing, X25519 for encryption).
6. Audit integrity.

**Trust boundaries**
- **B1** Browser and the portal origin. The JS is served by the portal, so trust is only as good as the portal.
- **B2** Portal Worker, D1 and the Cloudflare account. Treated as untrusted for authorization.
- **B3** The Hub process. The only place a connector change is allowed.
- **B4** Third-party IdPs (Google, Microsoft and others). Reached directly from the Hub.
- **B5** Custom MCP or REST endpoints. Untrusted code and data.
- **B6** Staff behind Cloudflare Access, including view-as.

| Attacker | S | T | R | I | D | E | What stops it |
|---|---|---|---|---|---|---|---|
| **A1 Full portal compromise** (code, D1, CF account) | Makes up commands | Swaps commands during a real ceremony; swaps the Hub's encryption key; swaps the OAuth user_code | Edits portal audit | Reads secrets typed into its own pages | Drops or delays commands | Adds a passkey to D1 | Hub keeps its own trust root (§2.2). Privilege-adding commands need confirmation on the Hub (§2.4). Secrets can be entered on the Hub (§3). The Hub keeps its own audit. **A1 can deny service; it cannot cause a change.** |
| **A2 Stolen email session** (magic link or code) | Acts as the user in the portal | — | — | Reads telemetry | Unpairs Hubs | Enrolls a new passkey in D1 | The new passkey is not on the Hub list until existing passkeys approve it (quorum) or someone confirms it on the device. Email alone can never authorize a Hub command. |
| **A3 Rogue staff / view-as** | — | — | Denies actions | Sees telemetry | — | Uses view-as to act | View-as sessions are rejected by the command routes (they already reject writes). Staff have no passkey on any Hub list. Even with portal code access, staff are A1. |
| **A4 Network MITM** | — | Edits envelopes | — | — | Blocks traffic | — | TLS, plus a passkey signature over the whole command, plus a portal envelope signature. |
| **A5 Replay** | — | — | — | — | — | Re-runs an old command | Nonce cache on the Hub, `expiresAt` of 10 minutes or less, signCount checks, and hubId/accountId inside the signed content. |
| **A6 Malicious MCP server** | — | Prompt-injects through tool output | — | Pulls data out through tool arguments | Floods the Hub | Calls tools outside the allowlist; SSRF into the LAN | Tool allowlist with a read or write flag per tool, sandbox, egress rules (§5). |
| **A7 Compromised Hub** | Pretends to be the Hub | — | — | Exposes its own secrets | — | Signs bad heartbeats | Damage stays on that one Hub: it has its own keys and the portal holds nothing reusable. Revoke it and re-pair. |

---

## 2. Command channel

### 2.1 Format and transport
The Hub pulls commands; nothing connects in to the Hub. Polling uses the existing signed-request scheme (`hubs/index.ts:64-82`): `GET /api/hubs/commands`, a 300 s skew window, and the replay cache. Long-poll for 25 s, or fall back to the heartbeat.

The signed command is RFC 8785 canonical JSON (JCS):
```json
{"v":1,"cmd":"connector.set_mode","hubId":"…","accountId":"…","nonce":"<128-bit b64url>",
 "issuedAt":1760000000,"expiresAt":1760000600,"params":{"connector":"gmail","mode":"read"},
 "summary":"Gmail: change write → read"}
```
- **Challenge sent to the passkey:** `SHA-256("albena-cmd-v1\0" || JCS(cmd))`.
- **What the browser returns:** `{cmd, credentialId, authenticatorData, clientDataJSON, signature}`.
- **What the portal adds:** a relay envelope `{cmdHash, relayedAt, portalKid, portalSig}`. It is signed with an Ed25519 key kept in a Worker secret, separate from session keys, and the Hub pins it at pairing. This only lets the Hub drop junk early. **A command signed only by the portal is rejected.**

### 2.2 How passkey keys reach the Hub
The Hub keeps its own `trusted_passkeys.json`: credentialId, COSE public key, signCount, userId, role, when it was added and who added it. It is **never** filled from D1 alone.

- **Bootstrap (first passkey):** the "allow portal control" switch is turned on locally, on the Hub panel or by voice plus PIN.
  1. The portal sends the user's existing passkey public key along with an enrollment request.
  2. The Hub shows the credential fingerprint as 6 words, plus the account email.
  3. The user does a passkey assertion over `hash(enroll-request)` in the portal.
  4. The portal shows the same 6 words, and the user confirms on the Hub with the PIN.

  Without a local panel, scan a QR code shown by the Hub (it carries the Hub's nonce) and assert. This is trust-on-first-use, but it needs someone physically present at the Hub.
- **Adding a passkey later:** either a quorum (any one existing trusted passkey signs `passkey.add{pubkey}`, then a Hub PIN confirmation) or the bootstrap flow again.
- **Removing a passkey:** any trusted passkey can do it. Removing the last one turns portal control off.
- **Lost all passkeys:** do the on-device bootstrap again. There is **no** email-based recovery for Hub control, on purpose.
- **Household members:** members are added the same way. A `role` field limits what each one can do; only the owner can add MCP servers.

### 2.3 Checks on the Hub, in order, failing closed

**First round (reject on any failure):**
1. The kill switches allow it: portal control is on locally, there is no global halt in the signed release manifest, and no local halt.
2. The envelope's portal signature is valid. This is only a quick filter.
3. `hubId` matches this Hub and `accountId` matches the paired account.
4. `issuedAt - 60 ≤ now ≤ expiresAt`, and `expiresAt - issuedAt ≤ 600`.
5. The nonce has not been seen. Keep the nonce cache for 900 s and save it to disk so it survives a restart.
6. The credential is in the Hub's own trust list.
7. Checks on `clientDataJSON`:
   - `type == "webauthn.get"`
   - `challenge == the challenge the Hub recomputes from cmd`
   - `origin == https://account.albena.ai`
   - `crossOrigin` is absent or false
8. Checks on `authenticatorData`:
   - `rpIdHash == SHA-256("account.albena.ai")`
   - the UP and UV flags are set
   - signCount is greater than the stored value, or both are 0 (synced passkeys report 0, so don't lean on this check)
9. The ECDSA or EdDSA signature is valid over `authData || SHA-256(clientDataJSON)`.
10. `cmd` is on the allowlist and `params` match a strict JSON schema (no extra keys, bounded sizes).
11. The signer's `role` is allowed to run this `cmd`.

**Then route by risk:**
- **Reduces privilege** (`disconnect`, `write→read`, `tool.remove`): run it, then notify.
- **Adds privilege** (`connect`, `read→write`, `tool.add`, `mcp.add`, `passkey.add`): call `approvals.request(..., risk="high", destructive=True)`. Setting `destructive=True` blocks the `trusted()` shortcut (`approvals.py:152`), and approval needs the PIN on a Hub screen that shows the summary the **Hub** produced from `params`. The portal's `summary` field is never shown.

### 2.4 What WebAuthn can't do, and what covers it
- **The authenticator never shows the transaction.** A compromised portal can show "change to read" while asking for a signature over "add an MCP server". Hub confirmation covers every privilege-adding command.
- **Synced passkeys** (iCloud or Google) mean the passkey is only as safe as the user's cloud account. That's acceptable because Hub confirmation is the last check.
- **The portal JS also runs the ceremony.** That's why the passkey only proves presence, as described above.
- **High-risk commands also get a push** through the Albena app channel, which goes Hub to app directly and not through the portal. Tapping it opens the Hub's own summary.

### 2.5 Fix now (before Phase 2)
`heartbeat` returns `remoteAccess` and `updateChannel` (CONTRACT.md Hubs section, `hubs/stats.ts:67`), and the Hub cannot check them. Either:
- (a) treat them as display-only and apply them only from signed commands, or
- (b) have the Hub ignore them.

Otherwise a compromised portal can already turn on remote access on every Hub.

---

## 3. Secret delivery

- **OAuth (preferred):** the Hub runs the RFC 8628 device-code flow directly with the IdP, and tokens never leave the Hub. Risk: a compromised portal could show the attacker's own `user_code`, so the user would approve the attacker's client (consent phishing). Fix: the Hub shows the `user_code` and the client name on its own panel or app, and the portal page just says "approve the code shown on your Hub". If only the portal can display, show the code on both and ask the user to compare. Ask only for the scopes the chosen read or write mode needs.
- **API keys and MCP tokens:**
  - At pairing, the Hub makes an X25519 key and publishes `{encPub, kid, notAfter}` signed with its Ed25519 identity (the portal already stores that public key).
  - The browser seals the secret with HPKE (RFC 9180, DHKEM-X25519/HKDF-SHA256/AES-256-GCM). The additional data is `hubId‖cmdNonce‖connectorId`.
  - The ciphertext goes into the passkey-signed command as `params.sealed`, so it is bound to that one command.
  - The portal keeps it in D1 with a 15-minute TTL and deletes it when the Hub fetches it. Cron sweeps (`cron.ts`) clear anything left.
  - **Limit:** this protects against a D1 dump, logs, staff and a passive attacker. It does **not** protect against swapped portal JS, which can read what the user types or swap `encPub` (the browser can only check the key using JS the portal served). So the default path for secrets is **entering them on the Hub's local UI or in the Albena app.** Portal entry is an opt-in convenience with this risk stated. If the key was swapped, the Hub can't decrypt, so the command fails and nothing changes. The secret may still have leaked, and the user should rotate it.
- **Rotation:** rotate `encPub` every 90 days, and also on any trust-root change. The Hub accepts the previous key for 24 h. Ed25519 identity rotation is a new pairing.
- **Revocation and Hub replacement:**
  - When a Hub is unpaired, the portal deletes its row, its pending ciphertext and its key.
  - A new Hub starts with an empty trust root, so connectors must be set up again. There is no cloud escrow, by design.
  - The old Hub's wipe on unpair is local: `albena reset` erases the keychain and the credentials store.

---

## 4. Abuse controls

- **Kill switches:**
  1. **Global:** a `portal_control:false` flag in the release manifest the Hub already checks, signed with the release key and not the portal key, so the portal can't turn control back on.
  2. **Per account:** the portal stops relaying. This only denies; it can't be used to grant.
  3. **On the Hub:** "allow portal control", **off by default**, and only the Hub can turn it on.
- **Rate limits** (portal, using existing `limits.ts` patterns): 10 commands an hour per account, 3 privilege-adding commands an hour, 1 pending `passkey.add`. The Hub enforces the same caps on its own side.
- **Expiry:** 10 minutes or less, checked on the Hub. Approval prompts on the Hub time out at `EXPIRE_S`.
- **Audit:**
  - `correlationId = cmd.nonce` on both sides.
  - Portal: `hub.cmd.issue/relay/fetched/result` in the existing hash-chained audit (`auditchain.ts`).
  - Hub: an append-only JSONL file chained with SHA-256 and anchored daily by including the head hash in the heartbeat. This makes later edits on either side detectable.
  - Each Hub audit entry records cmdHash, credentialId, decision, approver and PIN-verified true/false. Secret values are never logged.
- **Alerting:**
  - Any Hub rejection of a reason other than "expired" sends a push to the owner and flags the account.
  - So does a portal-signed command that has no valid passkey signature. That is a sign of A1.
  - The portal alerts staff on rejection spikes across Hubs (a sign the portal itself is compromised).

---

## 5. MCP specifics

- **Per-server tool allowlist,** read or write flag on each tool, deny by default. A tool that isn't listed is dropped from `tools/list` before the model sees it. Write tools go through `approvals.request` the same way Charles does. A server changing its tool list after it is added triggers a fresh approval on the Hub.
- **Egress rules on the Hub** for custom MCP or REST URLs:
  - HTTPS only.
  - Resolve DNS once and pin the resolved IP.
  - Deny RFC1918, loopback, link-local and 169.254.169.254, CGNAT 100.64/10, Tailscale, ULA fc00::/7, and `.local`/`.home.arpa`, unless the user explicitly allows a LAN target on the Hub.
  - No redirects to a different host. Responses capped at 1 MB with a 30 s timeout.
- **Sandbox:** each stdio MCP server runs under its own unprivileged user. On NVIDIA Hubs that's a seccomp container with read-only root, no host mounts and egress through the filtering proxy. On Mac it's `sandbox-exec` or an App Sandbox helper. Only that server's token is passed in through env or fd.
- **Prompt injection:** tool output is tagged as untrusted in the model context, and write calls that a tool's output triggers still need approval.
- **The portal never fetches, checks or proxies MCP URLs.** It only passes the URL as a schema-checked string (`https://`, 2048 characters or fewer).

---

## 6. Compliance mapping

| Control | How this design meets it |
|---|---|
| AC-3, AC-6 | The Hub decides, per command and per role. Tool allowlists. Least-privilege scopes. |
| AC-17 | Remote admin only by pull, signed and approved. Remote access is off by default. |
| IA-2(1), IA-2(2), IA-2(8) | Phishing-resistant MFA (passkey with UV) plus a local PIN. Replay-resistant through nonces and challenges. |
| IA-5, IA-5(2) | Public keys only in the portal. Hub keys kept locally. Rotation intervals defined. |
| SC-8, SC-8(1) | TLS plus end-to-end signature and HPKE confidentiality. |
| SC-12, SC-13 | Key lifecycle as in §3. Ed25519, P-256, X25519 and AES-GCM, using FIPS-validated modules where possible (WebCrypto, OpenSSL 3 FIPS provider). |
| SC-23 | Each command is bound to hubId, accountId, nonce and expiry. |
| AU-2, AU-3, AU-9, AU-10 | Two audit trails, each hash-chained, with a correlation id. Non-repudiation comes from the user's passkey signature, which the portal can't create. |
| CM-3, CM-5 | Each connector change is a recorded change with approval (Obvera Change ID on the Hub). |
| SI-10 | Strict schemas on both ends. |
| SA-8 | Least privilege, no single point of trust, fails closed. |
| SR-3 | MCP servers treated as supply-chain risk: sandbox and allowlist. Release manifest signed. |
| SOC 2 CC6.1, CC6.2, CC6.3, CC6.6, CC6.7, CC6.8 | Logical access, credentials, transmission and malicious code controls. |
| SOC 2 CC7.2, CC7.3 | Rejection alerts. |
| SOC 2 CC8.1 | Approved changes. |

**What keeps the portal out of credential custody:**
- It stores only public keys and short-lived HPKE ciphertext it can't decrypt.
- It holds no IdP client secrets for customer connectors.
- It has no authority to authorize anything.

Write this down as a boundary statement in `controls/inventory.md` and add a line to `soc2-tsc.csv` (CC6.1). State the limit plainly: portal entry of secrets is safe against a portal that is read or leaked, not one whose code is replaced. The Hub-entry path is the default.

---

## 7. Residual risks, tests, phases

**Residual risks**
1. **Active portal compromise plus a careless user:** the user approves on the Hub without reading it. Mitigation: plain-language summaries made on the Hub, risk colors, and a hold-to-approve control.
2. **Secrets typed into a compromised portal page leak.** Mitigated by Hub-entry as the default.
3. **Synced-passkey account takeover combined with physical access to the Hub PIN.**
4. **Denial of service by the portal.** Accepted.
5. **Bugs in the MCP sandbox.**
6. **A malicious household member** within their role.

**Test plan, built and run in CI:**
- Forged commands: portal signature only; wrong rpId or origin; `crossOrigin=true`; UV flag cleared; hubId or accountId swapped; expired; expiry span over 600 s; replayed nonce, including across a Hub restart; extra param keys; oversized fields; a JCS mismatch between the challenge and the command.
- Trust root: a passkey present in D1 but not on the Hub is rejected; quorum add works; removing the last passkey turns control off.
- A1 simulation: run a modified portal build that swaps the command during a real ceremony and confirm the Hub prompt shows the real command and the action is blocked. Swap `encPub` and confirm decryption fails. Swap the user_code and confirm the Hub shows a different code.
- Heartbeat `remoteAccess` tampering no longer has any effect.
- SSRF suite against the egress filter: DNS rebinding, IPv6-mapped v4, redirects, decimal or hex IPs.
- An MCP server that changes its tool list after approval, or emits tool output with prompt injection.
- Pen test before GA, with a third party focused on A1.

**Phases and effort**

| Phase | Scope | Effort |
|---|---|---|
| P0 | Make `remoteAccess`/`updateChannel` display-only on the Hub; Hub-side audit chain | 2–3 days |
| P1 | Command queue in the portal, JCS plus envelope, Hub verifier library (Python, using `webauthn` or `cryptography`), trust-root bootstrap and quorum, kill switches, privilege-reducing commands only | 2–3 weeks |
| P2 | Privilege-adding commands through `approvals` with PIN, Albena app push, OAuth device flow on the Hub | 2 weeks |
| P3 | HPKE secret path (opt-in), key rotation, Hub-entry UI as the default | 1–1.5 weeks |
| P4 | MCP: allowlist, egress proxy, sandbox per platform | 2–3 weeks |
| P5 | A1 red-team, pen test, control evidence | 1 week plus vendor time |

Total is about 10 to 12 engineering weeks.

## Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **Chosen: passkey proves presence, Hub confirms privilege-adding commands** | Holds up against full portal compromise | An extra step on a second device |
| Passkey only | Smooth UX | A compromised portal can swap commands during a real ceremony |
| Secrets entered on the Hub only | Strongest; the portal never sees plaintext | Less convenient |
| HPKE entry in the portal | Convenient | Safe only against a portal that is read or leaked, not one whose code is replaced |
| No email recovery for Hub control | Email can't be used to take over a Hub | A customer who loses every passkey must be physically at the Hub |

## References
- `portal/CONTRACT.md`: heartbeat returns `remoteAccess`; connectors live on the Hub.
- `portal/worker/src/hubs/index.ts:13,64-82`: 300 s skew window, signature check, replay cache in `hub_nonces`.
- `portal/worker/src/hubs/crypto.ts:30-41`: the string the Hub signs, and Ed25519 verification.
- `portal/worker/src/auth/passkeys.ts:55,82-88`: origin and rpId checks, UV required, counter updated with a compare-and-swap. The keys live in D1, which is why the Hub needs its own trust root.
- `portal/worker/src/hubs/stats.ts:67`: `remoteAccess` returned to the Hub.
- `albena:hub/portal_client.py:121-145`: the Hub signs its requests but does not check portal responses.
- `albena:approvals.py:146-153`: the `trusted()` auto-run shortcut, which portal commands must avoid by using `destructive=True`.