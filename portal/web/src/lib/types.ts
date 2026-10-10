// UI view-models. The wire shapes live in api.ts (W namespace) and match portal/CONTRACT.md exactly.
export interface Me { id: string; email: string; role: 'owner' | 'member'; accountId: string; viewAs?: { actor: string; expiresAt: number } }
export interface Passkey { id: string; createdAt: string }
export interface Session { id: string; current: boolean; createdAt: string; lastSeenAt: string }
export interface SignIn { at: string; method: 'passkey' | 'magic_link' }
export type PlanId = 'byo' | 'hub_mac' | 'hub_nvidia' | 'estate';
/** Plans an account can hold: the four paid plans, plus a time-boxed pilot that staff can grant. */
export type HeldPlan = PlanId | 'pilot';
export type Interval = 'monthly' | 'annual';
export interface BillingSummary {
  plan: HeldPlan | 'none'; planName: string; status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete' | 'none' | 'suspended' | 'expired';
  interval: Interval | null; renewsAt: string | null; cancelAtPeriodEnd: boolean; maxHubs: number;
  /** 'manual' = set up by the Albena team (no Stripe subscription behind it). */
  source: 'stripe' | 'manual'; endsAt: string | null; comp: boolean;
}
export interface Invoice { id: string; number: string; date: string; amount: number; currency: string; status: 'paid' | 'open' | 'void' | 'uncollectible' | 'draft'; url: string | null }
export interface Hub {
  id: string; name: string; edition: 'mac' | 'nvidia'; version: string; profile: string;
  updateChannel: 'stable' | 'beta'; remoteAccess: boolean; lastSeenAt: string | null; online: boolean; health: 'ok' | 'degraded' | null;
  summary: { cpu_pct: number | null; mem_used_mb: number | null; mem_total_mb: number | null } | null;
}
export interface PairStart { code: string; expiresAt: string }
export interface Release { edition: string; version: string; releasedAt: string; manifestUrl: string; signatureUrl: string; sha256: string }
export interface Order { id: string; item: string; placedAt: string; status: 'processing' | 'shipped' | 'delivered' | 'canceled'; total: number | null; currency: string | null; carrier: string | null; tracking: string | null }
export interface Member { id: string; email: string; role: 'owner' | 'member'; status: 'active' }
/** Connectors live on the Hub, so the portal always reports an empty list. */
export interface Connector { id: string; name: string; status: 'connected' | 'needs_attention' }
export interface PendingInvite { id: string; email: string; expiresAt: string }
export interface Account { id: string; members: Member[]; invites: PendingInvite[]; connectors: Connector[] }

/** Telemetry snapshot: every field is optional (a Hub reports only what it knows). Missing renders as an em dash, never 0. */
export interface HubStats {
  uptime_s?: number; cpu_pct?: number; load1?: number; mem_used_mb?: number; mem_total_mb?: number; disk_used_gb?: number; disk_total_gb?: number; temp_c?: number;
  gpu?: { name: string; util_pct: number; mem_used_mb: number; mem_total_mb: number; temp_c?: number }[];
  services?: ([string, string] | [string, string, number])[];
  ai?: { mode?: 'local' | 'local+cloud'; models?: { lane: string; name: string; loaded: boolean }[]; avg_latency_ms?: number };
  activity?: { requests_24h?: number; requests_7d?: number; wakes_24h?: number; approvals_pending?: number; approvals_24h?: number };
  updates?: { latest_known?: string; last_result?: string; last_at?: number };
}
export interface HubDetail {
  id: string; accountId?: string; name: string; edition: 'mac' | 'nvidia'; profile: string; version: string; updateChannel: 'stable' | 'beta'; remoteAccess: boolean;
  health: { ok: boolean; services: ([string, string] | [string, string, number])[] } | null; stats: HubStats | null; lastSeen: number | null; online: boolean; createdAt: number;
  /** Only present for the account owner, view-as sessions and staff. */
  publicNetwork?: { ip: string | null; isp: string | null; asn: number | null; city: string | null; region: string | null; country: string | null; timezone: string | null; changedAt: number | null };
}
export interface MetricPoint { ts: number; cpu: number | null; mem_pct: number | null; gpu_util: number | null; gpu_mem_pct: number | null; latency_ms: number | null }
export type MetricRange = '24h' | '7d';
