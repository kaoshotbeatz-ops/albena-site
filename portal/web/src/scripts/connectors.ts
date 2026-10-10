import './shell';
import { api } from '../lib/api';
import { h, must, panel, chip, dot, failInto, empty } from '../lib/ui';
import { ACCESS_HELP, ACCESS_TEXT, DOCS_URL, SOON, STATE_TEXT, lastUsed, stateChip, unverifiedBadge, type Shown } from '../lib/connections';
import type { CatalogItem, ConnectionsView, HubConn } from '../lib/types';

const root = must('#root');
let view: ConnectionsView;
const f = { q: '', cat: 'all', status: 'all' };

const stateFor = (c: CatalogItem, hubId: string): { state: Shown; conn?: HubConn } => {
  const conn = c.hubs.find((x) => x.hubId === hubId);
  return conn ? { state: conn.state, conn } : { state: 'not_set_up' };
};
const overall = (c: CatalogItem): Shown[] => (view.hubs.length ? view.hubs.map((x) => stateFor(c, x.id).state) : ['not_set_up']);

function connectButton() {
  const b = h('button', { class: 'btn btn-sm', type: 'button', disabled: true }, 'Connect');
  return h('span', { class: 'tip', title: SOON, tabindex: '0', role: 'group', 'aria-label': `Connect. ${SOON}` }, b);
}

function card(c: CatalogItem) {
  const multi = view.hubs.length > 1;
  const rows = (view.hubs.length ? view.hubs : [null]).map((hub) => {
    const { state, conn } = hub ? stateFor(c, hub.id) : { state: 'not_set_up' as Shown, conn: undefined };
    const access = conn?.access;
    return h('div', { class: 'conn-hub' },
      multi && hub ? h('span', { class: 'conn-hubname' }, hub.name) : null,
      stateChip(state, conn?.verified),
      access ? h('span', { class: 'chip ' + (access === 'write' ? 'indigo' : 'grey'), title: ACCESS_HELP[access] }, ACCESS_TEXT[access]) : null,
      conn ? h('span', { class: 'sub' }, lastUsed(conn.last_used_h)) : null,
      access ? h('span', { class: 'sub' }, ACCESS_HELP[access]) : null);
  });
  const caps = h('span', { class: 'sub' }, c.write ? 'Can read, and can propose changes you approve.' : 'Read only.');
  return h('li', { class: 'conn-card' },
    h('div', { class: 'main' }, h('span', { class: 'name' }, c.name), h('span', { class: 'sub' }, c.description), caps),
    h('div', { class: 'conn-states' }, ...rows),
    h('div', { class: 'row conn-actions' }, connectButton(), h('a', { class: 'btn btn-sm btn-ghost', href: DOCS_URL, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `How to connect ${c.name} today` }, 'How to connect today')));
}

function matches(c: CatalogItem) {
  if (f.cat !== 'all' && c.category !== f.cat) return false;
  if (f.q && !`${c.name} ${c.description}`.toLowerCase().includes(f.q.toLowerCase())) return false;
  if (f.status !== 'all' && !overall(c).includes(f.status as Shown)) return false;
  return true;
}

function results() {
  const out: Node[] = [];
  for (const cat of view.categories) {
    const items = view.catalog.filter((c) => c.category === cat.id && matches(c));
    if (!items.length) continue;
    out.push(h('section', { class: 'conn-cat', 'aria-labelledby': `cat-${cat.id}` }, h('h2', { id: `cat-${cat.id}`, class: 'conn-cat-h' }, cat.label), h('ul', { class: 'conn-grid' }, ...items.map(card))));
  }
  const custom = view.custom.filter((x) => f.status === 'all' || x.state === f.status).filter((x) => !f.q || x.label.toLowerCase().includes(f.q.toLowerCase()));
  if (custom.length && (f.cat === 'all')) {
    const name = (id: string) => view.hubs.find((x) => x.id === id)?.name ?? 'Hub';
    const own = panel('Your own connections', h('ul', { class: 'list' }, ...custom.map((x) => h('li', {},
      h('div', { class: 'main' }, h('span', { class: 'name' }, dot(x.state === 'connected' ? 'ok' : x.state === 'needs_attention' ? 'warn' : ''), x.label),
        h('span', { class: 'sub' }, `${x.kind.toUpperCase()} on ${name(x.hubId)}. ${lastUsed(x.last_used_h)}`)),
      h('span', { class: 'row' }, chip(ACCESS_TEXT[x.access], x.access === 'write' ? 'indigo' : 'grey'), chip(STATE_TEXT[x.state], x.state === 'connected' ? 'green' : x.state === 'needs_attention' ? 'amber' : 'grey'), unverifiedBadge(x.state, x.verified))))));
    own.querySelector('.panel-body')?.classList.add('flush');
    out.push(own);
  }
  return out.length ? out : [empty('No connectors match.')];
}

function render() {
  const list = h('div', { class: 'stack', 'aria-live': 'polite' }, ...results());
  const search = h('input', { class: 'input', type: 'search', id: 'cq', placeholder: 'Search connectors', 'aria-label': 'Search connectors', autocomplete: 'off', value: f.q });
  const cat = h('select', { class: 'select', 'aria-label': 'Category' }, h('option', { value: 'all' }, 'All categories'), ...view.categories.map((c) => h('option', { value: c.id }, c.label)));
  const st = h('select', { class: 'select', 'aria-label': 'Status' }, ...(['all', 'connected', 'needs_attention', 'off', 'not_set_up'] as const).map((s) => h('option', { value: s }, s === 'all' ? 'Any status' : STATE_TEXT[s])));
  cat.value = f.cat; st.value = f.status;
  const refresh = () => list.replaceChildren(...results());
  search.addEventListener('input', () => { f.q = search.value.trim(); refresh(); });
  cat.addEventListener('change', () => { f.cat = cat.value; refresh(); });
  st.addEventListener('change', () => { f.status = st.value; refresh(); });
  const unreported = view.hubs.filter((x) => !x.reported);
  const offline = view.hubs.filter((x) => !x.online && x.reported);
  root.replaceChildren(h('div', { class: 'stack' },
    h('p', { class: 'note', id: 'soon-note' }, 'Connectors are set up on your Hub. This page shows names and status only; credentials and tokens never pass through the portal. Connecting from the portal is coming in a later phase.'),
    !view.hubs.length ? h('p', { class: 'note warn', role: 'status' }, 'No Hub is paired yet, so nothing is set up.') : null,
    unreported.length ? h('p', { class: 'note', role: 'status' }, `${unreported.map((x) => x.name).join(', ')} has not reported its connections yet (needs a newer Hub version).`) : null,
    offline.length ? h('p', { class: 'note warn', role: 'status' }, `${offline.map((x) => x.name).join(', ')} is offline. States shown are its last report.`) : null,
    h('div', { class: 'conn-filters' }, search, cat, st), list));
}

api.connectors().then((v) => { view = v; root.setAttribute('aria-busy', 'false'); render(); }).catch((e) => failInto(root, e));
