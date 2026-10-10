// Shared rendering for connector status (customer /connectors, Hub detail, staff customer page). Read-only; names and status only.
import { h, chip, dot, empty, panel } from './ui';
import type { CatalogItem, ConnectionsView, ConnState } from './types';

export type Shown = ConnState | 'not_set_up';
export const STATE_TEXT: Record<Shown, string> = { connected: 'Connected', needs_attention: 'Needs attention', off: 'Off', not_set_up: 'Not set up' };
export const stateTone = (s: Shown) => (s === 'connected' ? 'green' : s === 'needs_attention' ? 'amber' : 'grey');
export const stateDot = (s: Shown) => (s === 'connected' ? 'ok' : s === 'needs_attention' ? 'warn' : '') as 'ok' | 'warn' | '';
export const ACCESS_TEXT = { read: 'Read', write: 'Write' } as const;
export const ACCESS_HELP = {
  read: 'Read: Albena can look at this, but cannot change anything.',
  write: 'Write: Albena can propose changes. Nothing happens until you approve it.',
} as const;
export const DOCS_URL = 'https://albena.ai/connectors';
export const SOON = 'Coming soon: connect from the portal securely (Phase 2)';

/** Coarse on purpose: the Hub reports whole hours. */
export function lastUsed(hours: number | undefined): string {
  if (hours === undefined) return 'No recent use reported';
  if (hours < 1) return 'Used within the last hour';
  if (hours < 48) return `Last used ${hours} h ago`;
  return `Last used ${Math.round(hours / 24)} d ago`;
}

export const stateChip = (s: Shown, verified?: boolean) => h('span', { class: 'row' }, dot(stateDot(s)), chip(STATE_TEXT[s], stateTone(s)), unverifiedBadge(s, verified));

export const UNVERIFIED_TEXT = 'Connected \u2014 not yet verified';
export const UNVERIFIED_HELP = "Albena hasn't health-checked this connection yet.";
/** Neutral/amber outline badge: only when the Hub explicitly says verified === false on a connected entry (absent = older Hub, no badge). */
export function unverifiedBadge(s: Shown, verified?: boolean): HTMLElement | null {
  if (s !== 'connected' || verified !== false) return null;
  return h('span', { class: 'chip chip-outline amber', title: UNVERIFIED_HELP, tabindex: '0', 'aria-label': `${UNVERIFIED_TEXT}. ${UNVERIFIED_HELP}` }, UNVERIFIED_TEXT);
}

/** The summary rows for one Hub: only what that Hub reported. */
export function hubRows(view: ConnectionsView, hubId: string) {
  const rows: { name: string; sub: string; state: ConnState; access: 'read' | 'write'; used?: number; verified?: boolean }[] = [];
  for (const c of view.catalog) for (const x of c.hubs) if (x.hubId === hubId) rows.push({ name: c.name, sub: x.kind === 'builtin' ? c.description : `via ${x.kind.toUpperCase()}`, state: x.state, access: x.access, used: x.last_used_h, verified: x.verified });
  for (const x of view.custom) if (x.hubId === hubId) rows.push({ name: x.label, sub: `Your own ${x.kind.toUpperCase()} connection`, state: x.state, access: x.access, used: x.last_used_h, verified: x.verified });
  return rows;
}

const order: Record<ConnState, number> = { needs_attention: 0, connected: 1, off: 2 };

/** Connections summary panel for one Hub (Hub detail, customer and staff). */
export function connectionsPanel(view: ConnectionsView, hubId: string, staffMode: boolean, title = 'Connections'): HTMLElement {
  const hub = view.hubs.find((x) => x.id === hubId);
  const rows = hubRows(view, hubId).sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
  const link = staffMode ? null : h('a', { class: 'btn btn-sm', href: '/connectors' }, 'All connectors');
  if (!hub?.reported) return panel(title, [empty('This Hub has not reported its connections yet.'), h('p', { class: 'note' }, 'Names and status only. Credentials stay on the Hub.')], link ?? undefined);
  const counts = (['connected', 'needs_attention', 'off'] as const).map((s) => [s, rows.filter((r) => r.state === s).length] as const);
  const summary = h('p', { class: 'row' }, ...counts.filter(([, n]) => n).map(([s, n]) => chip(`${n} ${STATE_TEXT[s].toLowerCase()}`, stateTone(s))));
  const list = rows.length
    ? h('ul', { class: 'list conn-list' }, ...rows.map((r) => h('li', {},
      h('div', { class: 'main' }, h('span', { class: 'name' }, dot(stateDot(r.state)), r.name), h('span', { class: 'sub' }, `${r.sub}. ${lastUsed(r.used)}`)),
      h('span', { class: 'row' }, chip(ACCESS_TEXT[r.access], r.access === 'write' ? 'indigo' : 'grey'), chip(STATE_TEXT[r.state], stateTone(r.state)), unverifiedBadge(r.state, r.verified)))))
    : empty('No connectors set up on this Hub yet.');
  const p = panel(title, [rows.length ? summary : null, list, h('p', { class: 'note' }, 'Names and status only, as reported by the Hub. Credentials never leave the Hub.')], link ?? undefined);
  return p;
}

export const itemTitle = (c: CatalogItem) => `${c.name}: ${c.description}`;
