import { api, type AuditPage, type AuditRow, type Integrity } from './api';
import { emptyRow, h, handleError, must, setBusy, timeEl } from './ui';

const table = must<HTMLTableElement>('#tbl');
const body = must('tbody', table);
const q = must<HTMLInputElement>('#q');
const count = must('#count');
const more = must<HTMLButtonElement>('#more');
const chain = must('#chain');

let rows: AuditRow[] = [];
let next: number | null = null;

function render() {
  const needle = q.value.trim().toLowerCase();
  const view = rows.filter((r) => !needle || `${r.id} ${r.actor} ${r.action} ${r.target ?? ''} ${r.request_id}`.toLowerCase().includes(needle));
  body.replaceChildren(...view.map((r) => h('tr', {},
    h('td', { class: 'mono mut num' }, String(r.id)), h('td', { class: 'mut num' }, timeEl(r.ts)),
    h('td', { class: 'clip' }, r.actor), h('td', { class: 'mono' }, r.action),
    h('td', { class: 'mono clip' }, r.target ?? ''), h('td', { class: 'mono mut clip', title: r.request_id }, r.request_id.slice(0, 8)),
    h('td', { class: 'mono mut' }, r.hash_prefix ?? 'unsealed'))));
  if (!view.length) body.replaceChildren(emptyRow(7, rows.length ? 'No loaded entries match.' : 'No audit entries.'));
  count.textContent = `${view.length} of ${rows.length} loaded${next ? ' (older entries available)' : ''}`;
  more.hidden = next === null;
}

async function load() {
  more.setAttribute('disabled', '');
  setBusy(table, true);
  try {
    const p = await api<AuditPage>(`/api/admin/audit?limit=50${next ? `&before=${next}` : ''}`);
    rows = rows.concat(p.items); next = p.next_before; render();
  } catch (e) {
    body.replaceChildren(emptyRow(7, handleError(e) ? 'Session expired — reload to sign in.' : 'Could not load the audit log.'));
  } finally { more.removeAttribute('disabled'); setBusy(table, false); }
}

async function loadChain() {
  try {
    const i = await api<Integrity>('/api/admin/integrity');
    const ok = i.chain.ok;
    chain.className = `banner ${ok ? 'is-ok' : 'is-error'}`;
    chain.replaceChildren(h('span', {}, ok
      ? `Audit chain intact: ${i.chain.rows.toLocaleString()} entries, ${i.chain.sealed.toLocaleString()} sealed, ${i.chain.unsealed} awaiting seal.`
      : `Audit chain BROKEN at entry #${i.chain.brokenAtId ?? '?'} (${i.chain.reason ?? 'mismatch'}). Investigate immediately.`),
      h('a', { href: `/admin/system${location.search}`, class: 'btn btn-sm' }, 'System details'));
  } catch (e) {
    handleError(e);
    chain.className = 'banner is-warn';
    chain.replaceChildren(h('span', {}, 'Chain status unavailable.'));
  }
}

q.addEventListener('input', render);
more.addEventListener('click', () => void load());
body.replaceChildren(emptyRow(7, 'Loading…'));
void loadChain();
void load();
