// UI view-models. The wire shapes live in api.ts (W namespace) and match portal/CONTRACT.md exactly.
export interface Me { id: string; email: string; role: 'owner' | 'member'; accountId: string; viewAs?: { actor: string; expiresAt: number } }
export interface Passkey { id: string; createdAt: string }
export interface Session { id: string; current: boolean; createdAt: string; lastSeenAt: string }
export interface SignIn { at: string; method: 'passkey' | 'magic_link' }
export type PlanId = 'byo' | 'hub_mac' | 'hub_nvidia' | 'estate';
export type Interval = 'monthly' | 'annual';
export interface BillingSummary {
  plan: PlanId | 'none'; planName: string; status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete' | 'none';
  interval: Interval | null; renewsAt: string | null; cancelAtPeriodEnd: boolean; maxHubs: number;
}
export interface Invoice { id: string; number: string; date: string; amount: number; currency: string; status: 'paid' | 'open' | 'void' | 'uncollectible' | 'draft'; url: string | null }
export interface Hub {
  id: string; name: string; edition: 'mac' | 'nvidia'; version: string; profile: string;
  updateChannel: 'stable' | 'beta'; remoteAccess: boolean; lastSeenAt: string | null; online: boolean; health: 'ok' | 'degraded' | null;
}
export interface PairStart { code: string; expiresAt: string }
export interface Release { edition: string; version: string; releasedAt: string; manifestUrl: string; signatureUrl: string; sha256: string }
export interface Order { id: string; item: string; placedAt: string; status: 'processing' | 'shipped' | 'delivered' | 'canceled'; total: number | null; currency: string | null }
export interface Member { id: string; email: string; role: 'owner' | 'member'; status: 'active' }
/** Connectors live on the Hub, so the portal always reports an empty list. */
export interface Connector { id: string; name: string; status: 'connected' | 'needs_attention' }
export interface Account { id: string; members: Member[]; connectors: Connector[] }
