// Dev-only mock backend (imported only when import.meta.env.DEV && ?mock=1; absent from production builds).
import { ApiError } from './api';

// Mock responses use the exact wire shapes of the worker (see W in api.ts and portal/CONTRACT.md).
const now = Math.floor(Date.now() / 1000);
const H = 3600, D = 24 * H;

let hubs = [
  { id: 'h1', name: 'Living room Hub', edition: 'mac', version: '1.8.2', profile: 'balanced', updateChannel: 'stable', remoteAccess: false, health: { ok: true, services: [['voice', 'ok']] }, lastSeen: now - 120, createdAt: now - 60 * D },
  { id: 'h2', name: 'Workshop (NVIDIA)', edition: 'nvidia', version: '1.8.1', profile: 'performance', updateChannel: 'beta', remoteAccess: true, health: { ok: false, services: [['voice', 'degraded']] }, lastSeen: now - 3 * H, createdAt: now - 30 * D },
];
const invoices = [3, 2, 1].map((n) => ({ id: `in_${n}`, number: `ALB-000${n}`, status: 'paid', amountPaid: 4900, amountDue: 0, currency: 'usd', created: now - (n * 30 - 18) * D, hostedInvoiceUrl: `https://example.invalid/i/${n}`, pdf: null }));
let passkeys = [{ id: 'pk1', createdAt: now - 60 * D }, { id: 'pk2', createdAt: now - 20 * D }];
let sessions = [
  { id: 's1', current: true, createdAt: now - 2 * H, lastSeen: now - 60, expiresAt: now + 6 * D },
  { id: 's2', current: false, createdAt: now - 5 * D, lastSeen: now - 6 * H, expiresAt: now + 2 * D },
];
const members = [{ id: 'm1', email: 'omar@example.com', role: 'owner', status: 'active' }, { id: 'm2', email: 'deena@example.com', role: 'member', status: 'active' }];

export function handle(method: string, path: string, body: unknown): unknown {
  const url = new URL(path, 'https://x.invalid');
  const p = url.pathname;
  const b = (body ?? {}) as Record<string, unknown>;
  if (p === '/api/me') return { user: { id: 'u1', email: 'omar@example.com', role: 'owner', accountId: 'a1' } };
  if (p === '/api/billing/summary') return { entitlement: { plan: 'hub_mac', status: 'active', active: true, maxHubs: 1, billingInterval: 'monthly', currentPeriodEnd: now + 18 * D, cancelAtPeriodEnd: false, stripeSubscriptionId: 'sub_mock' }, hasBillingAccount: true };
  if (p === '/api/billing/invoices') return { invoices };
  if (p === '/api/billing/portal' || p === '/api/billing/checkout') return { url: '/billing?mock=1&redirected=1' };
  if (p === '/api/billing/orders') return { orders: [
    { id: 'hw_cs_1042', plan: 'hub_mac', shippingStatus: 'shipped', refunded: false, amountTotal: 249900, currency: 'usd', createdAt: now - 9 * D },
    { id: 'hw_cs_0977', plan: 'hub_nvidia', shippingStatus: 'pending_fulfillment', refunded: false, amountTotal: 349900, currency: 'usd', createdAt: now - 1 * D },
  ] };
  if (p === '/api/hubs/pair/start') return { code: 'K7QM4XRD', expiresAt: now + 600 };
  if (p === '/api/hubs' && method === 'GET') return { hubs };
  const hm = /^\/api\/hubs\/([^/]+)$/.exec(p);
  if (hm) {
    const hub = hubs.find((x) => x.id === hm[1]);
    if (!hub) throw new ApiError(404, 'not_found');
    if (method === 'DELETE') { hubs = hubs.filter((x) => x !== hub); return { ok: true }; }
    if (method === 'PATCH') { Object.assign(hub, b); return { hub }; }
  }
  if (p === '/api/releases/latest') {
    const ed = url.searchParams.get('edition') ?? 'mac';
    return { edition: ed, channel: 'stable', version: '1.8.2', manifestUrl: 'https://example.invalid/releases/1.8.2/manifest.json', signatureUrl: 'https://example.invalid/releases/1.8.2/manifest.json.sig', signature: null, signatureScheme: 'ssh-ed25519', namespace: 'albena-hub-release', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', releasedAt: now - 6 * D };
  }
  if (p === '/api/account') return { account: { id: 'a1', createdAt: now - 90 * D }, members, connectors: [] };
  if (p === '/api/account/members/invite') throw new ApiError(501, 'not_implemented');
  if (p === '/api/account/export') return { exportedAt: new Date().toISOString(), account: { id: 'a1' }, members, hubs };
  if (p === '/api/account/delete') return { ok: true };
  if (p === '/api/security/sessions') return { sessions };
  const sm = /^\/api\/security\/sessions\/([^/]+)$/.exec(p);
  if (sm) { sessions = sessions.filter((s) => s.id !== sm[1]); return { ok: true }; }
  if (p === '/api/security/history') return { events: [
    { at: new Date((now - 2 * H) * 1000).toISOString(), method: 'passkey' },
    { at: new Date((now - 5 * D) * 1000).toISOString(), method: 'magic_link' },
  ] };
  if (p === '/api/security/passkeys') return { passkeys };
  const pm = /^\/api\/security\/passkeys\/([^/]+)$/.exec(p);
  if (pm) { passkeys = passkeys.filter((k) => k.id !== pm[1]); return { ok: true }; }
  if (p === '/api/auth/logout') return { ok: true };
  throw new ApiError(404, 'not_found');
}
