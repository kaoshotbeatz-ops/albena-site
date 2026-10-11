import { beforeEach, describe, expect, it } from "vitest";
import { applyEntitlement } from "../src/billing/entitlements";
import { b64encode, sha256Hex } from "../src/hubs/crypto";
import { parseHeartbeat } from "../src/hubs/schema";
import { randomToken, sha256 } from "../src/auth/crypto";
import { ABSOLUTE_SECONDS, VIEWAS_COOKIE, now } from "../src/auth/sessions";
import { auditSince, clearPortalTables, client, e, lastAuditId, login, seedMember, seedOwner, testBindings } from "./helpers";

const SIG = "0123456789abcdef", SIG2 = "fedcba9876543210";
const hb = (security?: unknown) => ({ version: "1.8.2", profile: "home", updateChannel: "stable", health: { ok: true, services: [] }, stats: { ...(security === undefined ? {} : { security }) } });
const sec = (over: Record<string, unknown> = {}) => ({ chain: "broken", chain_rows: 120, break_sig: SIG, approvals_pending: 2, trust_grants: 3, denials_24h: 4, agentgate_mode: "enforce",
  events: [{ at: 1_790_000_000, kind: "denial", tool: "ha_call_service" }, { at: 1_790_000_100, kind: "chain_break" }], ...over });

describe("stats.security schema", () => {
  const ok = (s: unknown) => parseHeartbeat(hb(s)).ok;
  it("accepts the full block, an empty block and partial blocks", () => {
    const r = parseHeartbeat(hb(sec({ acked_sig: SIG2 })));
    expect(r.ok && r.value.stats?.security?.events).toHaveLength(2);
    for (const s of [{}, { chain: "absent" }, { events: [] }, { agentgate_mode: "shadow" }, { trust_grants: 0 }]) expect(ok(s)).toBe(true);
    expect(parseHeartbeat({ version: "1.8.2", profile: "home", updateChannel: "stable", health: { ok: true, services: [] } }).ok).toBe(true);
  });
  it("rejects unknown keys, bad enums, bad ranges, bad sigs and free text", () => {
    const bad: unknown[] = [
      sec({ extra: 1 }), sec({ chain: "ok" }), sec({ agentgate_mode: "on" }), sec({ break_sig: "xyz" }), sec({ break_sig: SIG.toUpperCase() }), sec({ acked_sig: "0123" }),
      sec({ approvals_pending: 10001 }), sec({ approvals_pending: -1 }), sec({ trust_grants: 1.5 }), sec({ denials_24h: 100001 }), sec({ chain_rows: "5" }),
      sec({ events: Array.from({ length: 21 }, () => ({ at: 1, kind: "denial" })) }),
      sec({ events: [{ at: 1, kind: "login" }] }), sec({ events: [{ at: 1, kind: "denial", tool: "Bad Tool" }] }), sec({ events: [{ at: 1, kind: "denial", tool: "a".repeat(33) }] }),
      sec({ events: [{ at: 1, kind: "denial", detail: "my diary" }] }), sec({ events: [{ at: -1, kind: "denial" }] }), sec({ events: "x" }), "text", [],
    ];
    for (const s of bad) expect(ok(s), JSON.stringify(s)).toBe(false);
  });
});

describe("portal security API", () => {
  let OWNER_PK: string, OWNER_MAGIC: string, MEMBER_PK: string, OTHER_PK: string, VIEWAS: string, hub: { id: string; kp: CryptoKeyPair };
  let seq = 0, ipN = 0, tick = 0; // a distinct timestamp per signed call (a repeated signature is a replay)
  const call = (path: string, cookie?: string, init: RequestInit = {}) => client(cookie, testBindings()).request(path, { ...init, headers: { "cf-connecting-ip": `10.8.0.${ipN}`, ...(init.headers as Record<string, string> | undefined) } });
  const post = (path: string, cookie: string | undefined, body?: unknown) => call(path, cookie, { method: "POST", body: JSON.stringify(body ?? {}) });

  async function pair(cookie: string) {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = b64encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey) as ArrayBuffer));
    const { code } = await (await call("/api/hubs/pair/start", cookie, { method: "POST" })).json() as any;
    const r = await call("/api/hubs/pair/complete", undefined, { method: "POST", body: JSON.stringify({ code, hubPublicKey: pub, edition: "mac", profile: "home", version: "1.0.0" }) });
    return { id: ((await r.json()) as any).hubId as string, kp };
  }
  async function heartbeat(h: { id: string; kp: CryptoKeyPair }, body: unknown) {
    const raw = JSON.stringify(body), ts = Math.floor(Date.now() / 1000) - 200 + ++tick, path = "/api/hubs/heartbeat";
    const sig = b64encode(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, h.kp.privateKey, new TextEncoder().encode(`POST\n${path}\n${ts}\n${await sha256Hex(raw)}`))));
    return call(path, undefined, { method: "POST", body: raw, headers: { "x-hub-id": h.id, "x-hub-timestamp": String(ts), "x-hub-signature": sig } });
  }
  const ack = (cookie: string | undefined, body: unknown = { sig: SIG }, id = hub.id) => post(`/api/hubs/${id}/security/chain-ack`, cookie, body);
  const replyOf = async (security?: unknown) => ((await (await heartbeat(hub, hb(security))).json()) as any);

  beforeEach(async () => {
    await clearPortalTables();
    const owner = await seedOwner("sp-u1", "sp-acc1");
    OWNER_PK = await login(owner, "passkey");
    OWNER_MAGIC = await login(owner, "magic");
    MEMBER_PK = await login(await seedMember("sp-u3", "sp-acc1"), "passkey");
    OTHER_PK = await login(await seedOwner("sp-u2", "sp-acc2"), "passkey");
    // read-only support view-as session for the owner's account
    const vt = randomToken(), ts = now();
    await e.DB.prepare("INSERT INTO sessions (id,token_hash,user_id,account_id,created_at,last_seen,expires_at,view_as,readonly,actor) VALUES (?,?,?,?,?,?,?,1,1,'staff@example.com')")
      .bind(crypto.randomUUID(), await sha256(vt), "sp-u1", "sp-acc1", ts, ts, ts + ABSOLUTE_SECONDS).run();
    VIEWAS = `${VIEWAS_COOKIE}=${vt}`;
    await applyEntitlement(e.DB, "sp-acc1", { plan: "estate", status: "active" }, ++seq);
    ipN++;
    hub = await pair(OWNER_PK);
    expect(hub.id).toBeTruthy();
  });

  it("stores the snapshot and shows it in the overview; empty security means null", async () => {
    expect(((await (await call("/api/security/overview", OWNER_PK)).json()) as any).hubs[0].security).toBeNull();
    expect((await heartbeat(hub, hb(sec()))).status).toBe(200);
    const o = await (await call("/api/security/overview", OWNER_PK)).json() as any;
    expect(o.hubs).toHaveLength(1);
    expect(o.hubs[0]).toMatchObject({ id: hub.id, online: true, pending: [], security: { chain: "broken", break_sig: SIG, trust_grants: 3, agentgate_mode: "enforce" } });
    expect(o.tiers.map((t: any) => t.id)).toEqual(["R0", "R1", "R2", "R3", "R4"]);
    expect((await heartbeat(hub, hb(sec({ bogus: 1 })))).status).toBe(400);
  });

  it("overview is tenant-scoped; a member can read it; anonymous is 401", async () => {
    await heartbeat(hub, hb(sec()));
    expect(((await (await call("/api/security/overview", OTHER_PK)).json()) as any).hubs).toEqual([]);
    expect(((await (await call("/api/security/overview", MEMBER_PK)).json()) as any).hubs[0].id).toBe(hub.id);
    expect((await call("/api/security/overview")).status).toBe(401);
  });

  it("other accounts' hubs are 404 for writes; unknown id is 404", async () => {
    await heartbeat(hub, hb(sec()));
    expect((await ack(OTHER_PK)).status).toBe(404);
    expect((await post(`/api/hubs/${hub.id}/security/revoke-trust`, OTHER_PK)).status).toBe(404);
    expect((await ack(OWNER_PK, { sig: SIG }, "nope")).status).toBe(404);
  });

  it("writes: member 403, magic-link session 403 passkey_required, view-as cannot write, CSRF header required", async () => {
    await heartbeat(hub, hb(sec()));
    const r = await ack(MEMBER_PK);
    expect(r.status).toBe(403); expect(((await r.json()) as any).error).toBe("forbidden");
    expect((await post(`/api/hubs/${hub.id}/security/revoke-trust`, MEMBER_PK)).status).toBe(403);
    const m = await ack(OWNER_MAGIC);
    expect(m.status).toBe(403); expect(((await m.json()) as any).error).toBe("passkey_required");
    expect(((await (await post(`/api/hubs/${hub.id}/security/revoke-trust`, OWNER_MAGIC)).json()) as any).error).toBe("passkey_required");
    expect((await ack(VIEWAS)).status).toBe(403);
    expect((await post(`/api/hubs/${hub.id}/security/revoke-trust`, VIEWAS)).status).toBe(403);
    // no CSRF header / wrong origin
    for (const headers of [{ "X-Requested-With": "" }, { Origin: "https://evil.example" }] as Record<string, string>[]) {
      const res = await call(`/api/hubs/${hub.id}/security/revoke-trust`, OWNER_PK, { method: "POST", body: "{}", headers });
      expect(res.status).toBe(403); expect(((await res.json()) as any).error).toBe("csrf_rejected");
    }
    expect((await e.DB.prepare("SELECT COUNT(*) n FROM hub_security_commands").first<{ n: number }>())!.n).toBe(0);
  });

  it("an old session without a recorded method is not a passkey session", async () => {
    const owner = { id: "sp-u1", email: "sp-u1@example.com", accountId: "sp-acc1", role: "owner" as const };
    expect(((await (await post(`/api/hubs/${hub.id}/security/revoke-trust`, await login(owner, null))).json()) as any).error).toBe("passkey_required");
  });

  it("chain-ack checks: no_break, sig_mismatch, already_acked, bad input, success with audit", async () => {
    expect(((await (await ack(OWNER_PK)).json()) as any).error).toBe("no_break"); // nothing reported yet
    await heartbeat(hub, hb(sec({ chain: "verified", break_sig: undefined })));
    expect((await ack(OWNER_PK)).status).toBe(409);
    await heartbeat(hub, hb(sec()));
    const mismatch = await ack(OWNER_PK, { sig: SIG2 });
    expect(mismatch.status).toBe(409); expect(((await mismatch.json()) as any).error).toBe("sig_mismatch");
    for (const b of [{}, { sig: "short" }, { sig: SIG, extra: 1 }, { sig: SIG, note: "x".repeat(201) }, { sig: SIG, note: "<b>hi</b>" }, { sig: SIG, note: 5 }]) expect((await ack(OWNER_PK, b)).status).toBe(400);
    await heartbeat(hub, hb(sec({ acked_sig: SIG })));
    expect(((await (await ack(OWNER_PK)).json()) as any).error).toBe("already_acked");

    await heartbeat(hub, hb(sec()));
    const before = await lastAuditId();
    const note = "checked the log, it was my restore";
    const res = await ack(OWNER_PK, { sig: SIG, note });
    expect(res.status).toBe(202); expect(((await res.json()) as any).ok).toBe(true);
    const rows = await e.DB.prepare("SELECT kind, sig, requested_by, note, delivered_at FROM hub_security_commands WHERE hub_id = ?").bind(hub.id).all<any>();
    expect(rows.results).toEqual([{ kind: "chain_ack", sig: SIG, requested_by: "sp-u1", note, delivered_at: null }]);
    const a = await e.DB.prepare("SELECT action, target, meta FROM audit_log WHERE id > ? AND action = 'security.chain.ack'").bind(before).all<any>();
    expect(a.results).toHaveLength(1);
    expect(a.results[0].target).toBe(hub.id);
    expect(JSON.parse(a.results[0].meta)).toEqual({ sig: SIG, noteLength: note.length });
    expect(a.results[0].meta).not.toContain("restore");
    // pending shows in the overview
    expect(((await (await call("/api/security/overview", MEMBER_PK)).json()) as any).hubs[0].pending[0].kind).toBe("chain_ack");
    // a repeat click does not queue a second row
    await ack(OWNER_PK, { sig: SIG });
    expect((await e.DB.prepare("SELECT COUNT(*) n FROM hub_security_commands").first<{ n: number }>())!.n).toBe(1);
  });

  it("revoke-trust queues, audits and is delivered once", async () => {
    const before = await lastAuditId();
    expect((await post(`/api/hubs/${hub.id}/security/revoke-trust`, OWNER_PK)).status).toBe(202);
    expect((await auditSince(before)).map((r) => r.action)).toContain("security.trust.revoke");
    const first = await replyOf(sec());
    expect(first.security).toEqual({ chainAck: null, revokeTrust: true });
    expect((await replyOf(sec())).security).toEqual({ chainAck: null, revokeTrust: false });
  });

  it("heartbeat reply: backward-compatible shape; chain_ack delivered once and marked delivered", async () => {
    const plain = await replyOf();
    expect(plain).toEqual({ ok: true, updateChannel: "stable", remoteAccess: false, security: { chainAck: null, revokeTrust: false } });
    await heartbeat(hub, hb(sec()));
    await ack(OWNER_PK, { sig: SIG });
    expect((await replyOf(sec())).security).toEqual({ chainAck: { sig: SIG }, revokeTrust: false });
    expect((await replyOf(sec())).security).toEqual({ chainAck: null, revokeTrust: false });
    const row = await e.DB.prepare("SELECT delivered_at, dropped FROM hub_security_commands WHERE hub_id = ?").bind(hub.id).first<any>();
    expect(row.delivered_at).toBeGreaterThan(0); expect(row.dropped).toBe(0);
    expect(((await (await call("/api/security/overview", OWNER_PK)).json()) as any).hubs[0].pending).toEqual([]);
  });

  it("a stale chain_ack (break changed or cleared) is dropped, never delivered", async () => {
    await heartbeat(hub, hb(sec()));
    await ack(OWNER_PK, { sig: SIG });
    expect((await replyOf(sec({ break_sig: SIG2 }))).security.chainAck).toBeNull();
    expect((await e.DB.prepare("SELECT delivered_at, dropped FROM hub_security_commands").first<any>()).dropped).toBe(1);
    expect((await replyOf(sec({ break_sig: SIG2 }))).security.chainAck).toBeNull();
    // a heartbeat that already shows it acknowledged also drops it
    await heartbeat(hub, hb(sec()));
    await e.DB.prepare("DELETE FROM hub_security_commands").run();
    await ack(OWNER_PK, { sig: SIG });
    expect((await replyOf(sec({ acked_sig: SIG }))).security.chainAck).toBeNull();
  });

  it("a heartbeat without a security block leaves a chain_ack queued", async () => {
    await heartbeat(hub, hb(sec()));
    await ack(OWNER_PK, { sig: SIG });
    expect((await replyOf()).security.chainAck).toBeNull();
    expect((await e.DB.prepare("SELECT delivered_at FROM hub_security_commands").first<any>()).delivered_at).toBeNull();
    expect((await replyOf(sec())).security.chainAck).toEqual({ sig: SIG });
  });

  it("unpairing a hub removes its queued commands", async () => {
    await post(`/api/hubs/${hub.id}/security/revoke-trust`, OWNER_PK);
    expect((await call(`/api/hubs/${hub.id}`, OWNER_PK, { method: "DELETE" })).status).toBe(200);
    expect((await e.DB.prepare("SELECT COUNT(*) n FROM hub_security_commands").first<{ n: number }>())!.n).toBe(0);
  });
});
