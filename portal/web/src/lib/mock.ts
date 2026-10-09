// Dev-only mock backend (imported only when import.meta.env.DEV && ?mock=1; absent from production builds).
import { ApiError } from './api';
import type { Hub, Invoice } from './types';

const now = Date.now();
const iso = (ms: number) => new Date(now + ms).toISOString();
const H = 3600e3, D = 24 * H;

let hubs: Hub[] = [
  { id: 'h1', name: 'Living room Hub', edition: 'mac', version: '1.8.2', profile: 'Balanced', updateChannel: 'stable', remoteAccess: false, lastSeenAt: iso(-2 * 60e3), online: true, health: 'ok' },
  { id: 'h2', name: 'Workshop (NVIDIA)', edition: 'nvidia', version: '1.8.1', profile: 'Performance', updateChannel: 'beta', remoteAccess: true, lastSeenAt: iso(-3 * H), online: false, health: 'degraded' },
];
const invoices: Invoice[] = [
  { id: 'in_3', number: 'ALB-0003', date: iso(-12 * D), amount: 4900, currency: 'usd', status: 'paid', url: 'https://example.invalid/i/3' },
  { id: 'in_2', number: 'ALB-0002', date: iso(-42 * D), amount: 4900, currency: 'usd', status: 'paid', url: 'https://example.invalid/i/2' },
  { id: 'in_1', number: 'ALB-0001', date: iso(-72 * D), amount: 4900, currency: 'usd', status: 'paid', url: 'https://example.invalid/i/1' },
];
let passkeys = [
  { id: 'pk1', name: 'MacBook Touch ID', createdAt: iso(-60 * D), lastUsedAt: iso(-1 * D) },
  { id: 'pk2', name: 'iPhone', createdAt: iso(-20 * D), lastUsedAt: iso(-4 * H) },
];
let sessions = [
  { id: 's1', current: true, device: 'Chrome on macOS', ip: '203.0.113.x', createdAt: iso(-2 * H), lastSeenAt: iso(-60e3) },
  { id: 's2', current: false, device: 'Safari on iPhone', ip: '198.51.100.x', createdAt: iso(-5 * D), lastSeenAt: iso(-6 * H) },
];
let members: { id: string; email: string; role: 'owner' | 'member'; status: 'active' | 'invited' }[] = [
  { id: 'm1', email: 'omar@example.com', role: 'owner', status: 'active' },
  { id: 'm2', email: 'deena@example.com', role: 'member' as const, status: 'active' as const },
];

export function handle(method: string, path: string, body: unknown): unknown {
  const url = new URL(path, 'https://x.invalid');
  const p = url.pathname;
  const b = (body ?? {}) as Record<string, unknown>;
  if (p === '/api/me') return { id: 'u1', email: 'omar@example.com', role: 'owner', accountId: 'a1', accountName: 'My home', passkeys };
  if (p === '/api/billing/summary') return { plan: 'hub_mac', planName: 'Hub for Mac', status: 'active', interval: 'month', renewsAt: iso(18 * D), amount: 4900, currency: 'usd', alerts: ['Hub "Workshop (NVIDIA)" has not checked in for 3 hours.'] };
  if (p === '/api/billing/invoices') return invoices;
  if (p === '/api/billing/portal' || p === '/api/billing/checkout') return { url: '/billing?mock=1&redirected=1' };
  if (p === '/api/billing/orders') return [
    { id: 'ORD-1042', item: 'Albena Hub (Mac mini M5 Pro, 64 GB)', placedAt: iso(-9 * D), status: 'shipped', tracking: '1Z999AA10123456784', total: 249900, currency: 'usd' },
    { id: 'ORD-0977', item: 'Setup kit', placedAt: iso(-70 * D), status: 'delivered', total: 4900, currency: 'usd' },
  ];
  if (p === '/api/hubs/pair/start') return { code: 'K7QM-4XRD'.replace('-', ''), expiresAt: iso(10 * 60e3) };
  if (p === '/api/hubs' && method === 'GET') return hubs;
  const hm = /^\/api\/hubs\/([^/]+)$/.exec(p);
  if (hm) {
    const hub = hubs.find((x) => x.id === hm[1]);
    if (!hub) throw new ApiError(404, 'not_found');
    if (method === 'DELETE') { hubs = hubs.filter((x) => x !== hub); return {}; }
    if (method === 'PATCH') { Object.assign(hub, b); return hub; }
  }
  if (p === '/api/releases/latest') {
    const ed = url.searchParams.get('edition') ?? 'mac';
    return { edition: ed, version: '1.8.2', releasedAt: iso(-6 * D), url: '/downloads?mock=1', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', sizeBytes: ed === 'mac' ? 812e6 : 2.4e9, notes: ['Faster wake-word detection.', 'New connector health checks.', 'Fixes a rare update stall on NVIDIA Hubs.'] };
  }
  if (p === '/api/account') return { id: 'a1', name: 'My home', members, connectors: [{ id: 'c1', name: 'Home Assistant', status: 'connected' }, { id: 'c2', name: 'Google Calendar', status: 'connected' }, { id: 'c3', name: 'Hue Bridge', status: 'needs_attention' }] };
  if (p === '/api/account/members/invite') { members = [...members, { id: `m${members.length + 1}`, email: String(b.email), role: 'member', status: 'invited' }]; return {}; }
  if (p === '/api/account/export') return { account: 'a1', exportedAt: iso(0), members, hubs };
  if (p === '/api/account/delete') return {};
  if (p === '/api/security/sessions') return sessions;
  const sm = /^\/api\/security\/sessions\/([^/]+)$/.exec(p);
  if (sm) { sessions = sessions.filter((s) => s.id !== sm[1]); return {}; }
  if (p === '/api/security/history') return [
    { at: iso(-2 * H), method: 'passkey', device: 'Chrome on macOS', ok: true },
    { at: iso(-5 * D), method: 'magic_link', device: 'Safari on iPhone', ok: true },
    { at: iso(-9 * D), method: 'magic_link', device: 'Firefox on Windows', ok: false },
  ];
  const pm = /^\/api\/security\/passkeys\/([^/]+)$/.exec(p);
  if (pm) { passkeys = passkeys.filter((k) => k.id !== pm[1]); return {}; }
  if (p === '/api/auth/logout') return {};
  throw new ApiError(404, 'not_found');
}
