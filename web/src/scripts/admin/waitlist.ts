import { fetchAll, type WaitlistRow } from './api';
import { compare, emptyRow, h, handleError, labelInterest, must, setBusy, timeEl, wireSort, type SortState } from './ui';

const table = must<HTMLTableElement>('#tbl');
const body = must('tbody', table);
const q = must<HTMLInputElement>('#q');
const filter = must<HTMLSelectElement>('#interest');
const count = must('#count');
const more = must<HTMLButtonElement>('#more');
const PAGE = 100;
const INVITE_URL = 'https://account.albena.ai/support/invite';

let all: WaitlistRow[] = [];
let shown = PAGE;
const sort: SortState = { key: 'created_at', dir: 'desc' };

function view(): WaitlistRow[] {
  const needle = q.value.trim().toLowerCase();
  const f = filter.value;
  const rows = all.filter((r) =>
    (!f || labelInterest(r.interest) === f) &&
    (!needle || `${r.email} ${r.name ?? ''} ${r.interest ?? ''}`.toLowerCase().includes(needle)));
  const k = sort.key as keyof WaitlistRow;
  rows.sort((a, b) => (k === 'created_at' || k === 'id' ? compare(a.created_at, b.created_at) || a.id - b.id : compare(a[k], b[k])) * (sort.dir === 'asc' ? 1 : -1));
  return rows;
}

function render() {
  const rows = view();
  const slice = rows.slice(0, shown);
  body.replaceChildren(...slice.map((r) => h('tr', {},
    h('td', { class: 'clip' }, r.email),
    h('td', { class: 'clip' }, r.name ?? ''),
    h('td', {}, r.interest ? r.interest : h('span', { class: 'mut' }, 'Not specified')),
    h('td', { class: 'mut num' }, timeEl(r.created_at)),
    // Opens the staff invite form on the portal with the address prefilled (the portal side is behind Cloudflare Access).
    h('td', {}, h('a', { class: 'btn btn-sm', href: `${INVITE_URL}?email=${encodeURIComponent(r.email)}`, rel: 'noopener', 'aria-label': `Invite ${r.email}` }, 'Invite')))));
  if (!slice.length) body.replaceChildren(emptyRow(5, all.length ? 'No signups match your filters.' : 'No signups yet.'));
  count.textContent = `${slice.length} of ${rows.length} shown${rows.length !== all.length ? ` (${all.length} total)` : ''}`;
  more.hidden = slice.length >= rows.length;
}

q.addEventListener('input', () => { shown = PAGE; render(); });
filter.addEventListener('change', () => { shown = PAGE; render(); });
more.addEventListener('click', () => { shown += PAGE; render(); });
wireSort(table, sort, () => { shown = PAGE; render(); });

setBusy(table, true);
body.replaceChildren(emptyRow(5, 'Loading…'));
fetchAll<WaitlistRow>('/api/admin/waitlist').then(({ items, truncated }) => {
  all = items;
  const kinds = [...new Set(items.map((r) => labelInterest(r.interest)))].sort();
  filter.append(...kinds.map((k) => h('option', { value: k }, k)));
  if (truncated) must('#trunc').hidden = false;
  render();
}).catch((e) => {
  if (!handleError(e)) body.replaceChildren(emptyRow(5, 'Could not load the waitlist.'));
  else body.replaceChildren(emptyRow(5, 'Session expired — reload to sign in.'));
}).finally(() => setBusy(table, false));
