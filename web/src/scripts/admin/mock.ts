// Dev-only fixtures for `astro dev` with ?mock=1. Never bundled into production (guarded by import.meta.env.DEV).
import type { AuditRow, TicketRow, TicketStatus, WaitlistRow } from './api';

const DAY = 86400000;
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const interests = ['Founders edition', 'Home edition', 'Estate edition', 'Developer preview', ''];
const first = ['Ava', 'Noah', 'Mia', 'Liam', 'Zoe', 'Eli', 'Ivy', 'Ravi', 'Lena', 'Omar', 'Tess', 'Kofi'];
const last = ['Brooks', 'Nakamura', 'Okafor', 'Silva', 'Haddad', 'Lindqvist', 'Moreno', 'Patel'];

const waitlist: WaitlistRow[] = Array.from({ length: 137 }, (_, i) => {
  const f = first[i % first.length], l = last[(i * 3) % last.length];
  return {
    id: 137 - i,
    email: `${f}.${l}${i}@example.com`.toLowerCase(),
    name: i % 9 === 4 ? null : `${f} ${l}`,
    interest: interests[(i * 7) % interests.length] || null,
    created_at: iso(i * 0.55 * DAY + (i % 5) * 3600000),
  };
});
waitlist[2] = { ...waitlist[2], name: '<img src=x onerror=alert(1)>', email: 'xss@example.com' };

const topics = ['bug', 'billing', 'hardware', 'privacy', 'other'];
const stat: TicketStatus[] = ['open', 'open', 'in_progress', 'resolved', 'closed', 'open'];
const tickets: TicketRow[] = Array.from({ length: 23 }, (_, i) => ({
  ticket_id: `ALB-${String(23 - i).padStart(6, '0')}`,
  name: `${first[i % first.length]} ${last[i % last.length]}`,
  email: `${first[i % first.length]}${i}@example.com`.toLowerCase(),
  topic: topics[i % topics.length],
  message: i === 1
    ? '<script>alert("x")</script> Escaping check.\nSecond line of the message.'
    : `Hi team,\n\nAlbena did not respond to the wake phrase twice this morning (case ${i}). The kitchen speaker blinks amber.\n\nThanks!`,
  status: stat[i % stat.length],
  created_at: iso(i * 0.8 * DAY + 3600000),
  updated_at: iso(i * 0.6 * DAY),
}));

const actors = ['omar@dbaomarhuertasllc.com', 'public', 'system'];
const actions = ['admin.waitlist.list', 'waitlist.signup', 'support.ticket', 'admin.integrity', 'backup.completed', 'admin.ticket.status:resolved', 'admin.export.waitlist', 'admin.denied'];
const audit: AuditRow[] = Array.from({ length: 120 }, (_, i) => {
  const action = actions[(i * 5) % actions.length];
  return {
    id: 1200 - i,
    ts: iso(i * 2.3 * 3600000),
    actor: action === 'admin.denied' ? 'anonymous' : actions.indexOf(action) < 3 && action.startsWith('admin') ? actors[0] : actors[(i + 1) % 3],
    action,
    target: action.startsWith('support') ? `ticket:ALB-${String(1 + (i % 20)).padStart(6, '0')}` : null,
    request_id: crypto.randomUUID(),
    hash_prefix: [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join(''),
  };
});

export function handle(path: string, init: RequestInit): unknown {
  const u = new URL(path, location.origin);
  const q = u.searchParams;
  const p = u.pathname;
  if (p === '/api/admin/waitlist') {
    const off = Number(q.get('offset') ?? 0), lim = Number(q.get('limit') ?? 100);
    return { items: waitlist.slice(off, off + lim), limit: lim, offset: off };
  }
  if (p === '/api/admin/tickets' && (init.method ?? 'GET') === 'GET') {
    const off = Number(q.get('offset') ?? 0), lim = Number(q.get('limit') ?? 100);
    return { items: tickets.slice(off, off + lim), limit: lim, offset: off };
  }
  const m = /^\/api\/admin\/tickets\/(ALB-\d+)$/.exec(p);
  if (m && init.method === 'PATCH') {
    const t = tickets.find((x) => x.ticket_id === m[1]);
    const body = JSON.parse(String(init.body)) as { status: TicketStatus };
    if (!t) throw new Error('not found');
    t.status = body.status;
    t.updated_at = new Date().toISOString();
    return { ok: true, id: t.ticket_id, status: t.status };
  }
  if (p === '/api/admin/audit') {
    const lim = Number(q.get('limit') ?? 50), before = Number(q.get('before') ?? Infinity);
    const rows = audit.filter((r) => r.id < before);
    const items = rows.slice(0, lim);
    return { items, limit: lim, next_before: rows.length > lim ? items[items.length - 1].id : null };
  }
  if (p === '/api/admin/integrity') {
    return {
      chain: { ok: true, rows: 1200, sealed: 1200, unsealed: 0, headHash: 'c0ffee'.repeat(10) + 'abcd' },
      lastBackupOk: true, lastBackupAt: iso(5 * 3600000), lastVerifiedAt: iso(3 * DAY),
    };
  }
  throw new Error(`mock: unhandled ${p}`);
}
