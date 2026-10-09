// Shared admin shell behaviour: js flag, mobile nav, session banner, mock flag.
import { MOCK } from './api';

document.documentElement.classList.add('js');

const toggle = document.querySelector<HTMLButtonElement>('[data-side-toggle]');
const nav = document.querySelector<HTMLElement>('[data-side-nav]');
toggle?.addEventListener('click', () => {
  const open = nav?.classList.toggle('open') ?? false;
  toggle.setAttribute('aria-expanded', String(open));
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && nav?.classList.contains('open')) { nav.classList.remove('open'); toggle?.setAttribute('aria-expanded', 'false'); toggle?.focus(); }
});
document.querySelector('[data-reload]')?.addEventListener('click', () => location.reload());

if (MOCK) {
  document.querySelector('[data-mock-flag]')?.removeAttribute('hidden');
  document.querySelectorAll<HTMLAnchorElement>('a[data-admin-link]').forEach((a) => { a.href = `${a.getAttribute('href')}?mock=1`; });
}
