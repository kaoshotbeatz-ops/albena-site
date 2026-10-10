import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { app } from "../src/index";
import { auditSystem } from "../src/auditchain";
import { getState, isHeld, maybeRunDaily, runChainCheck } from "../src/integrity";
import { client, e, login, seedOwner, testBindings } from "./helpers";

// ALB-SEC-1: tamper -> verifier catches it -> Obvera alert -> R3 refused (423) -> owner ack (audited) -> R3 allowed.
const TEAM = "int-team.cloudflareaccess.com", AUD = "aud-int", ADMIN = "omar@example.com";
let keys: CryptoKeyPair;
const alerts: any[] = [];
const env = (over = {}) => testBindings({ TEAM_DOMAIN: TEAM, ADMIN_AUD: AUD, SUPPORT_ADMIN_EMAILS: ADMIN, OBVERA_EVENTS_URL: "https://obvera.test/api/obvera/client/eventhub/ingest", OBVERA_EVENTS_KEY: "k-test", ...over });
const jwt = () => new SignJWT({ email: ADMIN }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(`https://${TEAM}`).setAudience(AUD).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
const staff = async (path: string, method = "GET", body?: unknown) => app.request("https://account.albena.ai" + path, {
  method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  headers: { "X-Requested-With": "albena-portal", Origin: "https://account.albena.ai", "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": await jwt() },
}, env());
const actions = async () => (await e.DB.prepare("SELECT action, target, meta FROM audit_log ORDER BY id").all<{ action: string; target: string; meta: string | null }>()).results;

beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const u = String(input);
    if (u.startsWith(`https://${TEAM}/cdn-cgi/access/certs`)) return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Content-Type": "application/json" } });
    if (u.startsWith("https://obvera.test/")) { alerts.push({ auth: init?.headers?.Authorization, body: JSON.parse(init.body) }); return new Response("{}", { status: 200 }); }
    return real(input, init);
  }));
});
beforeEach(async () => {
  alerts.length = 0;
  await e.DB.batch([
    e.DB.prepare("UPDATE chain_state SET status='unknown', broken_sig=NULL, broken_reason=NULL, broken_at_id=NULL, detected_at=NULL, acked_sig=NULL, acked_by=NULL, acked_at=NULL, ack_note=NULL, last_run_at=NULL, last_alert=NULL WHERE id=1"),
  ]);
});

describe("ALB-SEC-1 portal chain verifier and R3 hold", () => {
  it("green run records audit.chain.verified, no hold, no alert", async () => {
    for (let i = 0; i < 3; i++) await auditSystem(e, "t", `e${i}`, "x");
    const r = await runChainCheck(env(), "test");
    expect(r.chain.ok).toBe(true);
    expect(isHeld(r.state)).toBe(false);
    expect(r.alert).toBeNull();
    expect((await actions()).at(-1)!.action).toBe("audit.chain.verified");
  });

  it("tamper is caught, alerts Obvera, blocks R3 until acknowledged; ack is audited", async () => {
    for (let i = 0; i < 5; i++) await auditSystem(e, "t", `e${i}`, "x");
    const victim = (await e.DB.prepare("SELECT id FROM audit_log ORDER BY id LIMIT 1 OFFSET 2").first<{ id: number }>())!.id;
    // An attacker with direct DB access must first drop the append-only trigger, then rewrite a row.
    const trig = (await e.DB.prepare("SELECT sql FROM sqlite_master WHERE name = 'audit_no_rewrite'").first<{ sql: string }>())!.sql;
    await expect(e.DB.prepare("UPDATE audit_log SET meta = '{}' WHERE id = ?").bind(victim).run()).rejects.toThrow(/audit_write_guard/);
    await e.DB.prepare("DROP TRIGGER audit_no_rewrite").run();
    await e.DB.prepare("UPDATE audit_log SET meta = '{\"forged\":1}' WHERE id = ?").bind(victim).run();
    await e.DB.prepare(trig).run();

    const r = await runChainCheck(env(), "test");
    expect(r.chain).toMatchObject({ ok: false, reason: "hash_mismatch", brokenAtId: victim });
    expect(isHeld(r.state)).toBe(true);
    expect(r.alert).toBe("sent");
    expect(alerts[0]).toMatchObject({ auth: "Bearer k-test", body: { source: "albena-portal", type: "audit.chain_break", severity: "critical" } });
    expect((await actions()).some((a) => a.action === "audit.chain.broken")).toBe(true);

    // R3: account deletion refused for a real owner session; a normal read still works
    const owner = await seedOwner("int-owner");
    const c = client(await login(owner), env());
    const del = await c.request("/api/account/delete", { method: "POST", body: JSON.stringify({ confirm: owner.email }) });
    expect(del.status).toBe(423);
    expect((await c.request("/api/me")).status).toBe(200);
    expect((await staff("/api/support/view-as/start", "POST", { account: owner.accountId })).status).toBe(423);

    // acknowledge: exact signature + note required; writes audit.chain.ack
    expect((await staff("/api/support/integrity/ack", "POST", { sig: "hash_mismatch@424242", note: "checked" })).status).toBe(409);
    expect((await staff("/api/support/integrity/ack", "POST", { sig: r.state.broken_sig, note: "" })).status).toBe(400);
    const ok = await staff("/api/support/integrity/ack", "POST", { sig: r.state.broken_sig, note: "tamper test; investigating" });
    expect(ok.status).toBe(200);
    const ack = (await actions()).find((a) => a.action === "audit.chain.ack")!;
    expect(ack.target).toBe(r.state.broken_sig);
    expect(JSON.parse(ack.meta!)).toEqual({ note: "tamper test; investigating" });
    expect(isHeld(await getState(e))).toBe(false);
    expect((await staff("/api/support/view-as/start", "POST", { account: owner.accountId })).status).toBe(200);

    // the integrity endpoint shows the acknowledged break
    const st = await (await staff("/api/support/integrity")).json<any>();
    expect(st.integrity).toMatchObject({ status: "broken", acked_by: ADMIN });
  });

  it("cron runs the verifier once a day (04 UTC) and catches up after a missed day", async () => {
    await auditSystem(e, "t", "x", "y");
    expect(await maybeRunDaily(env(), new Date("2026-10-11T04:23:00Z"))).toBe(true);
    expect(await maybeRunDaily(env(), new Date("2026-10-11T05:23:00Z"))).toBe(false);
    expect(await maybeRunDaily(env(), new Date("2026-10-12T04:23:00Z"))).toBe(true);
    expect(await maybeRunDaily(env(), new Date("2026-10-13T07:23:00Z"))).toBe(true); // >26 h since the last run
    expect((await getState(e)).last_run_at).toBe("2026-10-13T07:23:00.000Z");
  });
});
