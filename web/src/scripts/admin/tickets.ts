import { api, ApiError, fetchAll, STATUSES, type TicketRow, type TicketStatus } from './api';
import { chipFor, compare, confirmDialog, emptyRow, h, handleError, must, setBusy, timeEl, toast, wireSort, type SortState } from './ui';

const table = must<HTMLTableElement>('#tbl');
const body = must('tbody', table);
const q = must<HTMLInputElement>('#q');
const count = must('#count');
const segs = must('#seg');
const drawer = must<HTMLDialogElement>('#drawer');
const dBody = must('#drawer-body');

let all: TicketRow[] = [];
let status: '' | TicketStatus = '';
let opener: HTMLElement | null = null;
const sort: SortState = { key: 'created_at', dir: 'desc' };

function renderSeg() {
  const n = (s: string) => (s ? all.filter((t) => t.status === s).length : all.length);
  segs.replaceChildren(...[['', 'All'], ...STATUSES.map((s) => [s, s.replace('_', ' ')])].map(([v, label]) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(status === v) }, label, h('span', { class: 'n' }, String(n(v))));
    b.addEventListener('click', () => { status = v as typeof status; renderSeg(); render(); });
    return b;
  }));
}

function render() {
  const needle = q.value.trim().toLowerCase();
  const rows = all.filter((t) => (!status || t.status === status) &&
    (!needle || `${t.ticket_id} ${t.name} ${t.email} ${t.topic} ${t.message}`.toLowerCase().includes(needle)));
  const k = sort.key as keyof TicketRow;
  rows.sort((a, b) => compare(a[k], b[k]) * (sort.dir === 'asc' ? 1 : -1));
  body.replaceChildren(...rows.map((t) => {
    const open = h('button', { type: 'button', class: 'linkbtn', 'aria-label': `Open ${t.ticket_id}` }, t.ticket_id);
    const tr = h('tr', { class: 'row-link' },
      h('td', { class: 'mono' }, open), h('td', { class: 'clip' }, t.topic),
      h('td', { class: 'clip' }, `${t.name} · ${t.email}`), h('td', {}, chipFor(t.status)),
      h('td', { class: 'mut num' }, timeEl(t.updated_at)));
    open.addEventListener('click', (e) => { e.stopPropagation(); openDrawer(t, open); });
    tr.addEventListener('click', () => openDrawer(t, open));
    return tr;
  }));
  if (!rows.length) body.replaceChildren(emptyRow(5, all.length ? 'No tickets match your filters.' : 'No tickets yet.'));
  count.textContent = `${rows.length} of ${all.length} tickets`;
}

function openDrawer(t: TicketRow, from: HTMLElement) {
  opener = from;
  const sel = h('select', { class: 'select', id: 'new-status' }, ...STATUSES.map((s) => h('option', { value: s }, s.replace('_', ' '))));
  sel.value = t.status;
  const apply = h('button', { type: 'button', class: 'btn btn-primary' }, 'Update status');
  const close = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, 'Close');
  close.addEventListener('click', () => drawer.close());
  apply.addEventListener('click', async () => {
    const next = sel.value as TicketStatus;
    if (next === t.status) { toast('Status unchanged.'); return; }
    const ok = await confirmDialog(`Change ${t.ticket_id} to "${next.replace('_', ' ')}"?`,
      `This updates the ticket from "${t.status.replace('_', ' ')}" and is recorded in the audit log.`, 'Change status');
    if (!ok) return;
    apply.setAttribute('disabled', '');
    try {
      await api(`/api/admin/tickets/${encodeURIComponent(t.ticket_id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }) });
      t.status = next; t.updated_at = new Date().toISOString();
      toast(`${t.ticket_id} is now ${next.replace('_', ' ')}.`);
      renderSeg(); render(); openDrawer(t, opener ?? from);
    } catch (e) {
      if (!handleError(e)) toast(e instanceof ApiError ? `Update failed (${e.code}).` : 'Update failed.', true);
      else drawer.close();
    } finally { apply.removeAttribute('disabled'); }
  });
  dBody.replaceChildren(
    h('div', { class: 'drawer-head' }, h('div', {}, h('h2', { id: 'drawer-title' }, t.ticket_id), h('p', { class: 'mut' }, t.topic)), close),
    h('dl', { class: 'meta' },
      h('dt', {}, 'Status'), h('dd', {}, chipFor(t.status)),
      h('dt', {}, 'From'), h('dd', {}, t.name),
      h('dt', {}, 'Email'), h('dd', {}, t.email),
      h('dt', {}, 'Created'), h('dd', {}, timeEl(t.created_at)),
      h('dt', {}, 'Updated'), h('dd', {}, timeEl(t.updated_at))),
    h('div', {}, h('h3', { class: 'mut', id: 'msg-h' }, 'Message'), h('div', { class: 'msg-box', role: 'region', 'aria-labelledby': 'msg-h', tabindex: '0' }, t.message)),
    h('div', { class: 'status-row' }, h('label', { for: 'new-status' }, 'Set status'), sel, apply));
  if (!drawer.open) drawer.showModal();
  sel.focus();
}
drawer.addEventListener('close', () => opener?.focus());
drawer.addEventListener('click', (e) => { if (e.target === drawer) drawer.close(); });

q.addEventListener('input', render);
wireSort(table, sort, render);
setBusy(table, true);
body.replaceChildren(emptyRow(5, 'Loading…'));
fetchAll<TicketRow>('/api/admin/tickets').then(({ items }) => { all = items; renderSeg(); render(); })
  .catch((e) => { body.replaceChildren(emptyRow(5, handleError(e) ? 'Session expired — reload to sign in.' : 'Could not load tickets.')); })
  .finally(() => setBusy(table, false));
