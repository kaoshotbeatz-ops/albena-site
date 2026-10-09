export interface Me { id: string; email: string; role: 'owner' | 'member'; accountId: string; accountName?: string; passkeys?: Passkey[] }
export interface Passkey { id: string; name: string; createdAt: string; lastUsedAt: string | null }
export interface Session { id: string; current: boolean; device: string; ip?: string; createdAt: string; lastSeenAt: string }
export interface SignIn { at: string; method: 'passkey' | 'magic_link'; device: string; ok: boolean }
export type PlanId = 'byo' | 'hub_mac' | 'hub_nvidia' | 'estate';
export type Interval = 'month' | 'year';
export interface BillingSummary {
  plan: PlanId | 'none'; planName: string; status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'none';
  interval?: Interval; renewsAt?: string | null; cancelAtPeriodEnd?: boolean; amount?: number; currency?: string;
  alerts?: string[];
}
export interface Invoice { id: string; number: string; date: string; amount: number; currency: string; status: 'paid' | 'open' | 'void' | 'uncollectible' | 'draft'; url?: string }
export interface Hub {
  id: string; name: string; edition: 'mac' | 'nvidia' | string; version: string; profile: string;
  updateChannel: 'stable' | 'beta'; remoteAccess: boolean; lastSeenAt: string | null; online: boolean; health?: 'ok' | 'degraded' | 'down';
}
export interface PairStart { code: string; expiresAt: string }
export interface Release { edition: string; version: string; releasedAt: string; url: string; sha256?: string; sizeBytes?: number; notes: string[] }
export interface Order { id: string; item: string; placedAt: string; status: 'processing' | 'building' | 'shipped' | 'delivered' | 'canceled'; tracking?: string; total?: number; currency?: string }
export interface Member { id: string; email: string; role: 'owner' | 'member'; status: 'active' | 'invited'; }
export interface Account { id: string; name: string; members: Member[]; connectors?: { id: string; name: string; status: 'connected' | 'needs_attention' }[] }
