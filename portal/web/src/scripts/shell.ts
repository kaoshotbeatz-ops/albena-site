// Shared app shell: js flag, session (me), drawer, workspace menu, search palette, mock link carrying.
import { api, MOCK } from '../lib/api';
import { h, $ } from '../lib/ui';

document.documentElement.classList.add('js');

const side = $('[data-side]')!;
const toggle = $<HTMLButtonElement>('[data-side-toggle]')!;
const scrim = $('[data-scrim]')!;
function setDrawer(open: boolean) {
  side.classList.toggle('open', open);
  scrim.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('lock', open);
  if (open) $<HTMLElement>('a[data-nav]', side)?.focus(); else if (document.activeElement && side.contains(document.activeElement)) toggle.focus();
}
toggle.addEventListener('click', () => setDrawer(!side.classList.contains('open')));
$('[data-side-close]')?.addEventListener('click', () => setDrawer(false));
scrim.addEventListener('click', () => setDrawer(false));

// Workspace menu
const wsBtn = $<HTMLButtonElement>('[data-ws-btn]')!;
const wsMenu = $('[data-ws-menu]')!;
function setWs(open: boolean) { wsMenu.hidden = !open; wsBtn.setAttribute('aria-expanded', String(open)); }
wsBtn.addEventListener('click', () => setWs(wsMenu.hidden === true));
document.addEventListener('click', (e) => { if (!wsMenu.hidden && !(e.target as Element).closest('.ws')) setWs(false); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!wsMenu.hidden) { setWs(false); wsBtn.focus(); }
  else if (side.classList.contains('open')) setDrawer(false);
});
$('[data-logout]')?.addEventListener('click', async () => {
  try { await api.logout(); } catch { /* still leave */ }
  location.assign('/login');
});

// Mock mode carries ?mock=1 across internal navigation.
if (MOCK) {
  $('[data-mock-flag]')?.removeAttribute('hidden');
  document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]').forEach((a) => {
    const u = new URL(a.getAttribute('href')!, location.origin);
    u.searchParams.set('mock', '1');
    a.href = u.pathname + u.search;
  });
}

// Command palette (⌘K / Ctrl+K, or "/")
const pal = $<HTMLDialogElement>('[data-palette]')!;
const input = $<HTMLInputElement>('#pal-in')!;
const listEl = $('#pal-list')!;
const pages = [...document.querySelectorAll<HTMLAnchorElement>('a[data-nav]')].map((a) => ({ label: (a.textContent ?? '').trim(), href: a.href }));
let active = 0;
function render() {
  const q = input.value.trim().toLowerCase();
  const hits = pages.filter((p) => p.label.toLowerCase().includes(q));
  active = Math.min(active, Math.max(hits.length - 1, 0));
  listEl.replaceChildren(...(hits.length ? hits.map((p, i) => {
    const li = h('li', { role: 'option', id: `pal-o${i}`, 'aria-selected': String(i === active), class: 'pal-o' }, p.label);
    li.addEventListener('click', () => location.assign(p.href));
    return li;
  }) : [h('li', { class: 'pal-none' }, 'No matching pages')]));
  input.setAttribute('aria-activedescendant', hits.length ? `pal-o${active}` : '');
  return hits;
}
function openPal() { input.value = ''; active = 0; render(); pal.showModal(); input.focus(); }
$('[data-search-open]')?.addEventListener('click', () => { setDrawer(false); openPal(); });
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!pal.open) openPal(); else pal.close(); }
});
input.addEventListener('input', () => { active = 0; render(); });
input.addEventListener('keydown', (e) => {
  const hits = render();
  if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % Math.max(hits.length, 1); render(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + hits.length) % Math.max(hits.length, 1); render(); }
  else if (e.key === 'Enter' && hits[active]) { e.preventDefault(); location.assign(hits[active].href); }
});
pal.addEventListener('click', (e) => { if (e.target === pal) pal.close(); });

// Who am I (401 redirects to /login inside api.ts)
export const meP = api.me().then((me) => {
  const name = 'My home';
  document.querySelectorAll('[data-ws-name],[data-ws-name2]').forEach((n) => { n.textContent = name; });
  const ico = $('.ws-ico'); if (ico) ico.textContent = name.slice(0, 1).toUpperCase();
  const who = $('[data-who]'); if (who) who.textContent = me.email;
  if (me.viewAs) enterViewAs(me.email);
  return me;
});
meP.catch(() => undefined);

// Support view-as: persistent banner, Exit, and every action control disabled. The server rejects writes regardless.
function enterViewAs(email: string) {
  document.documentElement.classList.add('viewas');
  const banner = $('[data-viewas-banner]'); if (!banner) return;
  banner.hidden = false;
  $('[data-viewas-email]')!.textContent = email;
  $<HTMLButtonElement>('[data-viewas-exit]')!.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement; btn.disabled = true;
    let to = 'https://albena.ai/admin';
    try { const r = await api.endViewAs(); if (r.redirect === to) to = r.redirect; } catch { /* the session still expires on its own */ }
    location.assign(to);
  });
  $('[data-logout]')?.setAttribute('hidden', '');
  const lock = () => document.querySelectorAll<HTMLElement>('main button, main input, main select, main textarea').forEach((el) => {
    if (el.closest('[data-allow-viewas]') || el.dataset.viewasLocked) return;
    el.dataset.viewasLocked = '1';
    el.setAttribute('aria-disabled', 'true'); el.setAttribute('title', 'Read-only support view');
    (el as HTMLButtonElement).disabled = true;
  });
  lock();
  new MutationObserver(lock).observe($('main')!, { childList: true, subtree: true });
}
