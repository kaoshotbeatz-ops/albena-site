import './shell';
import { api } from '../lib/api';
import { h, must, panel, chip, fmtDate, failInto } from '../lib/ui';
import type { Release } from '../lib/types';

const root = must('#root');
const EDITIONS = [
  { id: 'mac', name: 'Albena for Mac', req: 'macOS 15 or later, Apple silicon, 32 GB memory or more recommended.' },
  { id: 'nvidia', name: 'Albena for NVIDIA', req: 'Linux with an NVIDIA GPU (16 GB VRAM or more recommended).' },
];

function card(ed: (typeof EDITIONS)[number], r: Release | undefined) {
  if (!r) return panel(ed.name, h('p', { class: 'mut' }, 'No release is available yet.'));
  let href: string | undefined;
  try { const u = new URL(r.manifestUrl, location.origin); if (u.protocol === 'https:' || u.origin === location.origin) href = u.href; } catch { /* ignore */ }
  const dl = href ? h('a', { class: 'btn btn-primary', href }, `Release manifest v${r.version}`, h('span', { class: 'sr' }, ` for ${ed.name}`)) : h('span', { class: 'mut' }, 'Manifest unavailable');
  return panel(ed.name, [
    h('div', { class: 'row' }, chip(`v${r.version}`, 'indigo'), h('span', { class: 'mut' }, `Released ${fmtDate(r.releasedAt)}`),),
    h('p', { class: 'mut' }, ed.req),
    h('div', { class: 'row' }, dl),
    h('p', { class: 'mut' }, 'SHA-256 ', h('span', { class: 'mono' }, r.sha256)),
    h('p', { class: 'mut' }, 'Your Hub downloads and verifies this signed manifest itself when an update is available. Updates install from your Hub settings.'),
  ]);
}

(async () => {
  const res = await Promise.allSettled(EDITIONS.map((e) => api.release(e.id)));
  if (res.every((r) => r.status === 'rejected')) throw (res[0] as PromiseRejectedResult).reason;
  root.replaceChildren(h('div', { class: 'grid-2' }, ...EDITIONS.map((e, i) => card(e, res[i].status === 'fulfilled' ? (res[i] as PromiseFulfilledResult<Release>).value : undefined))));
  root.setAttribute('aria-busy', 'false');
})().catch((e) => failInto(root, e));
