// Staff API (Cloudflare Access gates /support/* and /api/support/*). Shapes match portal/worker/src/support/*.ts.
import { req } from './api';

const opt = { noRedirect: true };
const get = <T>(p: string) => req<T>('GET', p, undefined, opt);
const send = <T>(m: string, p: string, b: unknown = {}) => req<T>(m, p, b, opt);

export interface AccountRow { id: string; email: string; plan: string; status: string; source: string; endsAt: number | null; comp: number; hubs: number; created: number }
export interface Ent { plan: string; status: string; active: boolean; maxHubs: number; source: 'stripe' | 'manual'; endsAt: number | null; comp: boolean; note: string | null; stripeSubscriptionId: string | null }
export interface DetailHub { id: string; name: string; edition: string; profile: string; version: string; updateChannel: string; remoteAccess: boolean; health: { ok: boolean; services: [string, string][] } | null; lastSeen: number | null; createdAt: number }
export interface Detail {
  account: { id: string; createdAt: number; ownerEmail: string };
  users: { id: string; email: string; name: string | null; role: string }[];
  entitlement: Ent;
  history: { id: number; at: number; actor: string; kind: string; source: string; plan: string | null; status: string | null; endsAt: number | null; note: string | null }[];
  hubs: DetailHub[];
  reservedHubs: { id: string; serial: string; edition: string; name: string | null; createdAt: number; expiresAt: number; usedAt: number | null; hubId: string | null }[];
  orders: { id: string; source: string; plan: string; edition: string | null; status: string; carrier: string | null; tracking: string | null; notes: string | null; amountTotal: number | null; currency: string | null; createdAt: number; updatedAt: number | null }[];
  licenseKeys: { id: string; hint: string; label: string | null; createdAt: number; revokedAt: number | null; lastUsedAt: number | null; useCount: number }[];
  notes: { id: number; at: number; actor: string; body: string }[];
  invites: { id: string; email: string; plan: string | null; createdAt: number; expiresAt: number; acceptedAt: number | null; revokedAt: number | null; sendCount: number }[];
  audit: { id: number; ts: string; actor: string; action: string; target: string | null; meta: string | null }[];
}
export interface Invite { id: string; email: string; plan: string | null; days: number | null; note: string | null; invitedBy: string; createdAt: number; expiresAt: number; acceptedAt: number | null; revokedAt: number | null; accountId: string | null; sendCount: number; status: 'pending' | 'accepted' | 'revoked' | 'expired' }

export const staff = {
  accounts: () => get<{ me: string; accounts: AccountRow[] }>('/api/support/accounts'),
  account: (id: string) => get<Detail>(`/api/support/accounts/${encodeURIComponent(id)}`),
  createAccount: (b: Record<string, unknown>) => send<{ accountId: string }>('POST', '/api/support/accounts', b),
  grant: (id: string, b: Record<string, unknown>) => send<{ kind: string }>('POST', `/api/support/accounts/${encodeURIComponent(id)}/entitlement`, b),
  addNote: (id: string, body: string) => send<unknown>('POST', `/api/support/accounts/${encodeURIComponent(id)}/notes`, { body }),
  createOrder: (id: string, edition: string, notes: string) => send<unknown>('POST', `/api/support/accounts/${encodeURIComponent(id)}/orders`, { edition, ...(notes ? { notes } : {}) }),
  patchOrder: (id: string, b: Record<string, unknown>) => send<unknown>('PATCH', `/api/support/orders/${encodeURIComponent(id)}`, b),
  reserveHub: (id: string, b: Record<string, unknown>) => send<unknown>('POST', `/api/support/accounts/${encodeURIComponent(id)}/reserved-hubs`, b),
  cancelReserved: (id: string) => send<unknown>('DELETE', `/api/support/reserved-hubs/${encodeURIComponent(id)}`, undefined),
  mintKey: (id: string, label: string) => send<{ licenseKey: string; hint: string }>('POST', `/api/support/accounts/${encodeURIComponent(id)}/license-keys`, label ? { label } : {}),
  revokeKey: (id: string) => send<unknown>('DELETE', `/api/support/license-keys/${encodeURIComponent(id)}`, undefined),
  invites: () => get<{ invites: Invite[] }>('/api/support/invites'),
  invite: (b: Record<string, unknown>) => send<unknown>('POST', '/api/support/invites', b),
  bulkInvite: (b: Record<string, unknown>) => send<{ results: { email: string; ok: boolean; error?: string }[] }>('POST', '/api/support/invites/bulk', b),
  resendInvite: (id: string) => send<unknown>('POST', `/api/support/invites/${encodeURIComponent(id)}/resend`),
  revokeInvite: (id: string) => send<unknown>('DELETE', `/api/support/invites/${encodeURIComponent(id)}`, undefined),
};
