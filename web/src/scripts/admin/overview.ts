import { api, fetchAll, type AuditPage, type Integrity, type TicketRow, type WaitlistRow } from './api';
import { $, ago, chipFor, fmt, h, handleError, labelInterest, must } from './ui';

const kpis = must('#kpis');
const setKpi = (id: string, value: string, sub?: string, tone?: 'ok' | 'warn' | 'bad') => {
  const k = must(`[data-kpi="${id}"]`, kpis);
  k.classList.remove('skel');
  const dd = must('dd', k);
  dd.replaceChildren(...(tone ? [h('span', { class: `dot ${tone}`, 'aria-hidden': 'true' }), value] : [value]));
  if (tone) dd.classList.add('txt');
  const s = $('.sub2', k);
  if (s) s.textContent = sub ?? '';
};
const failKpi = (id: string) => setKpi(id, 'Unavailable', 'Could not load', 'warn');

async function loadWaitlist() {
  try {
    const { items, truncated } = await fetchAll<WaitlistRow>('/api/admin/waitlist');
    const total = `${items.length}${truncated ? '+' : ''}`;
    const week = items.filter((r) => Date.now() - Date.parse(r.created_at) < 7 * 86400000).length;
    setKpi('total', total, 'All signups');
    setKpi('week', String(week), 'Last 7 days');
    const by = new Map<string, number>();
    for (const r of items) by.set(labelInterest(r.interest), (by.get(labelInterest(r.interest)) ?? 0) + 1);
    const rows = [...by].sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...rows.map((r) => r[1]));
    const list = must('#by-interest');
    list.replaceChildren(...rows.map(([k, n]) => {
      const fill = h('div', { class: 'fill' });
      fill.style.setProperty('--p', String(Math.round((n / max) * 100)));
      return h('li', {}, h('span', { class: 'lbl', title: k }, k), h('div', { class: 'track', 'aria-hidden': 'true' }, fill), h('span', { class: 'num' }, String(n)));
    }));
    if (!rows.length) list.append(h('li', { class: 'mut' }, 'No signups yet.'));
  } catch (e) {
    handleError(e); failKpi('total'); failKpi('week');
    must('#by-interest').replaceChildren(h('li', { class: 'mut' }, 'Could not load signups.'));
  }
}

async function loadTickets() {
  try {
    const { items } = await fetchAll<TicketRow>('/api/admin/tickets');
    const open = items.filter((t) => t.status === 'open').length;
    const prog = items.filter((t) => t.status === 'in_progress').length;
    setKpi('tickets', String(open), `${prog} in progress`);
    const body = must('#recent-tickets');
    body.replaceChildren(...items.slice(0, 6).map((t) => h('tr', {},
      h('td', {}, h('a', { class: 'linkbtn', href: `/admin/tickets${location.search}` }, t.ticket_id)),
      h('td', { class: 'clip' }, t.topic), h('td', {}, chipFor(t.status)), h('td', { class: 'mut' }, ago(t.created_at)))));
    if (!items.length) body.replaceChildren(h('tr', {}, h('td', { class: 'empty', colspan: '4' }, 'No tickets yet.')));
  } catch (e) {
    handleError(e); failKpi('tickets');
    must('#recent-tickets').replaceChildren(h('tr', {}, h('td', { class: 'empty', colspan: '4' }, 'Could not load tickets.')));
  }
}

async function loadIntegrity() {
  try {
    const i = await api<Integrity>('/api/admin/integrity');
    const stale = !i.lastBackupOk;
    setKpi('backup', stale ? 'Attention' : 'Healthy', i.lastBackupAt ? `Last backup ${ago(i.lastBackupAt)}` : 'No backup recorded', stale ? 'bad' : 'ok');
    setKpi('verify', i.lastVerifiedAt ? ago(i.lastVerifiedAt) : 'Never', i.lastVerifiedAt ? fmt(i.lastVerifiedAt) : 'Weekly verify has not run', i.lastVerifiedAt ? 'ok' : 'warn');
    setKpi('chain', i.chain.ok ? 'Intact' : 'Broken', i.chain.ok ? `${i.chain.rows.toLocaleString()} entries, ${i.chain.unsealed} unsealed` : `${i.chain.reason ?? 'mismatch'} at #${i.chain.brokenAtId ?? '?'}`, i.chain.ok ? 'ok' : 'bad');
  } catch (e) {
    handleError(e); failKpi('backup'); failKpi('verify'); failKpi('chain');
  }
}

async function loadAudit() {
  const body = must('#recent-audit');
  try {
    const a = await api<AuditPage>('/api/admin/audit?limit=8');
    body.replaceChildren(...a.items.map((r) => h('tr', {},
      h('td', { class: 'mut' }, ago(r.ts)), h('td', { class: 'clip' }, r.actor), h('td', { class: 'mono clip' }, r.action))));
  } catch (e) {
    handleError(e);
    body.replaceChildren(h('tr', {}, h('td', { class: 'empty', colspan: '3' }, 'Could not load activity.')));
  }
}

void Promise.all([loadWaitlist(), loadTickets(), loadIntegrity(), loadAudit()]);
