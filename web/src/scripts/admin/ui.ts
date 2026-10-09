// Tiny DOM helpers. All data goes through textContent / setAttribute; never innerHTML.
import { MOCK, SessionError } from './api';

type Child = Node | string | null | undefined | false;
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) el.append(k);
  return el;
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
export const must = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => {
  const el = $<T>(sel, root);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

const dtf = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
export function fmt(ts: string | null | undefined): string {
  if (!ts) return 'Never';
  const d = new Date(ts);
  return Number.isNaN(+d) ? ts : dtf.format(d);
}
export function ago(ts: string | null | undefined): string {
  if (!ts) return 'never';
  const s = (Date.now() - Date.parse(ts)) / 1000;
  if (!Number.isFinite(s)) return ts;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
export const timeEl = (ts: string) => { const t = h('time', { datetime: ts, title: ts }, fmt(ts)); return t; };
export const labelInterest = (v: string | null) => (v && v.trim()) || 'Not specified';

export function showSession() { document.getElementById('session-banner')?.removeAttribute('hidden'); }
/** Returns true if the error was a session problem (already surfaced). */
export function handleError(e: unknown): boolean {
  if (e instanceof SessionError) { showSession(); return true; }
  return false;
}

let toastTimer: number | undefined;
export function toast(msg: string, error = false) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.toggle('is-error', error);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 4500);
}

export function confirmDialog(title: string, body: string, ok: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'confirm', 'aria-labelledby': 'cf-t' });
    const cancel = h('button', { class: 'btn btn-ghost', type: 'button' }, 'Cancel');
    const go = h('button', { class: 'btn btn-primary', type: 'button' }, ok);
    dlg.append(h('h2', { id: 'cf-t' }, title), h('p', {}, body), h('div', { class: 'actions' }, cancel, go));
    let result = false;
    cancel.onclick = () => dlg.close();
    go.onclick = () => { result = true; dlg.close(); };
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    document.body.append(dlg);
    dlg.showModal();
    cancel.focus();
  });
}

export function chipFor(status: string): HTMLElement {
  const tone = status === 'open' ? 'amber' : status === 'in_progress' ? 'indigo' : status === 'resolved' ? 'green' : 'grey';
  return h('span', { class: `chip ${tone}` }, status.replace('_', ' '));
}

// Generic sortable-table state: keeps sort key/dir and updates aria-sort on <th>.
export interface SortState { key: string; dir: 'asc' | 'desc' }
export function wireSort(table: HTMLTableElement, state: SortState, onChange: () => void) {
  const apply = () => table.querySelectorAll<HTMLTableCellElement>('th[data-key]').forEach((th) => {
    th.setAttribute('aria-sort', th.dataset.key === state.key ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  });
  table.querySelectorAll<HTMLButtonElement>('th[data-key] button').forEach((b) => b.addEventListener('click', () => {
    const key = b.closest('th')!.dataset.key!;
    state.dir = state.key === key && state.dir === 'asc' ? 'desc' : 'asc';
    state.key = key;
    apply();
    onChange();
  }));
  apply();
}
export function compare(a: unknown, b: unknown): number {
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' });
}

export function setBusy(el: HTMLElement, busy: boolean) { el.setAttribute('aria-busy', String(busy)); }
export function emptyRow(cols: number, text: string) {
  return h('tr', {}, h('td', { class: 'empty', colspan: String(cols) }, text));
}
export { MOCK };
