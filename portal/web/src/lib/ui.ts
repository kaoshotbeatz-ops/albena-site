// Tiny DOM helpers. All data goes through textContent / setAttribute; never innerHTML.
import { ApiError, MOCK, errMsg } from './api';

export type Child = Node | string | number | boolean | null | undefined;
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids) if (k) el.append(typeof k === 'number' ? String(k) : (k as Node | string));
  return el;
}
export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
export const must = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => {
  const el = $<T>(sel, root);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

const dtf = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const dttf = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
export const fmtDate = (ts?: string | null) => { if (!ts) return 'Never'; const d = new Date(ts); return Number.isNaN(+d) ? ts : dtf.format(d); };
export const fmtDateTime = (ts?: string | null) => { if (!ts) return 'Never'; const d = new Date(ts); return Number.isNaN(+d) ? ts : dttf.format(d); };
export function ago(ts?: string | null): string {
  if (!ts) return 'never';
  const s = (Date.now() - Date.parse(ts)) / 1000;
  if (!Number.isFinite(s)) return ts;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
export const money = (cents?: number, cur = 'usd') => cents === undefined ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase() }).format(cents / 100);
export const bytes = (n?: number) => !n ? '' : n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
export const chip = (text: string, tone = '') => h('span', { class: `chip ${tone}`.trim() }, text);
export const dot = (tone: 'ok' | 'warn' | 'bad' | '') => h('span', { class: `dot ${tone}`.trim(), 'aria-hidden': 'true' });

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
/** Runs an action, toasting failures. 401 already redirected by api.ts. */
export async function run<T>(btn: HTMLButtonElement | null, fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> {
  btn?.setAttribute('aria-disabled', 'true'); if (btn) btn.disabled = true;
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { if (!(e instanceof ApiError && e.status === 401)) toast(errMsg(e), true); return undefined; }
  finally { if (btn) { btn.disabled = false; btn.removeAttribute('aria-disabled'); } }
}
export function failInto(el: HTMLElement, e: unknown) {
  el.replaceChildren(h('p', { class: 'loading is-error', role: 'alert' }, errMsg(e)));
}

export function confirmDialog(title: string, body: string, ok: string, opts: { typed?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'confirm', 'aria-labelledby': 'cf-t' });
    const cancel = h('button', { class: 'btn btn-ghost', type: 'button' }, 'Cancel');
    const go = h('button', { class: `btn ${opts.danger ? 'btn-danger-solid' : 'btn-primary'}`, type: 'button' }, ok);
    const kids: Node[] = [h('h2', { id: 'cf-t' }, title), h('p', {}, body)];
    if (opts.typed) {
      const input = h('input', { class: 'input', id: 'cf-in', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'cf-hint' });
      go.disabled = true;
      input.addEventListener('input', () => { go.disabled = input.value.trim() !== opts.typed; });
      kids.push(h('div', { class: 'field' }, h('label', { for: 'cf-in', id: 'cf-hint' }, `Type ${opts.typed} to confirm`), input));
    }
    let result = false;
    cancel.onclick = () => dlg.close();
    go.onclick = () => { result = true; dlg.close(); };
    dlg.append(...kids, h('div', { class: 'actions' }, cancel, go));
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    document.body.append(dlg);
    dlg.showModal();
    (dlg.querySelector<HTMLElement>('input') ?? cancel).focus();
  });
}

export function panel(title: string, body: Child | Child[], action?: Node): HTMLElement {
  const p = h('section', { class: 'panel' });
  p.append(h('header', {}, h('h2', {}, title), action ?? null), h('div', { class: 'panel-body' }, ...(Array.isArray(body) ? body : [body])));
  return p;
}
export function table(caption: string, heads: string[], rows: Node[][]): HTMLElement {
  const tb = h('tbody');
  for (const r of rows) tb.append(h('tr', {}, ...r.map((c) => h('td', {}, c))));
  return h('div', { class: 'tbl-wrap', tabindex: '0', role: 'region', 'aria-label': caption },
    h('table', { class: 'tbl' }, h('caption', { class: 'sr' }, caption), h('thead', {}, h('tr', {}, ...heads.map((x) => h('th', { scope: 'col' }, x)))), tb));
}
export const empty = (text: string) => h('p', { class: 'empty-note' }, text);
export { MOCK };

/** Follows a provider URL from the API only if it is https (Stripe, etc.) or, in mock mode, same-origin. */
export function safeRedirect(url: string) {
  try {
    const u = new URL(url, location.origin);
    if (u.protocol === 'https:' || (MOCK && u.origin === location.origin)) { location.assign(u.href); return; }
  } catch { /* fallthrough */ }
  toast('Unexpected redirect blocked.', true);
}
