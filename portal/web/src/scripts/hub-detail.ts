// Hub detail (customer /hubs/<id> and read-only staff /support/hubs/<id>). Counts and numbers only; no conversation content ever reaches the portal.
import { api } from '../lib/api';
import { staff } from '../lib/staff';
import { h, must, chip, dot, ago, fmtDateTime, failInto, empty, table, panel, toast } from '../lib/ui';
import { connectionsPanel } from '../lib/connections';
import type { ConnectionsView, HubDetail, HubStats, MetricPoint, MetricRange, ModuleSeries } from '../lib/types';

const staffMode = location.pathname.startsWith('/support/');
const id = decodeURIComponent(location.pathname.split('/')[staffMode ? 3 : 2] ?? '');
const fetchHub = (): Promise<HubDetail> => (staffMode ? staff.hub(id) : api.hubDetail(id));
const fetchMetrics = (r: MetricRange): Promise<MetricPoint[]> => (staffMode ? staff.hubMetrics(id, r) : api.hubMetrics(id, r));
const fetchModules = (r: MetricRange): Promise<ModuleSeries[]> => (staffMode ? staff.hubModules(id, r) : api.hubModules(id, r));

const root = must('#root');
const DASH = '—';
const iso = (s: number | null | undefined) => (s ? new Date(s * 1000).toISOString() : null);
/** Missing values are a dash, never 0. */
const n = (v: number | undefined | null, f: (x: number) => string = (x) => String(x)) => (v === undefined || v === null ? DASH : f(v));
const fixed = (d: number, unit = '') => (x: number) => `${x.toFixed(d)}${unit}`;
const pct = (used?: number, total?: number) => (used === undefined || total === undefined || total <= 0 ? null : (used / total) * 100);
const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
function dur(sec: number) {
  const d = Math.floor(sec / 86400), hr = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d} d ${hr} h` : hr ? `${hr} h ${m} min` : `${m} min`;
}
const kv = (rows: [string, string | Node][]) => h('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
const svcTone = (s: string) => (s === 'ok' ? 'green' : s === 'degraded' ? 'amber' : s === 'down' ? 'red' : 'grey');
function meter(label: string, p: number | null, text: string) {
  return h('div', { class: 'gauge' }, h('div', { class: 'gauge-h' }, h('span', {}, label), h('span', { class: 'num' }, text)),
    p === null ? null : h('meter', { class: 'meter', min: '0', max: '100', value: String(Math.round(p)), 'aria-label': `${label} ${text}` }));
}

// ---- charts: inline SVG, with a data table behind <details> ----
const NS = 'http://www.w3.org/2000/svg';
const sv = (tag: string, attrs: Record<string, string>) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
type Series = { key: keyof MetricPoint; label: string; cls: string };
function chart(title: string, pts: MetricPoint[], series: Series[], unit: string, fixedMax?: number): HTMLElement {
  const W = 640, H = 140, P = 6;
  const fig = h('figure', { class: 'chart' }, h('figcaption', {}, title));
  const vals = pts.flatMap((p) => series.map((s) => p[s.key]).filter((v): v is number => v !== null));
  if (pts.length < 2 || !vals.length) { fig.append(h('p', { class: 'empty-note' }, 'Not enough data yet.')); return fig; }
  const max = fixedMax ?? Math.max(1, ...vals) * 1.1;
  const t0 = pts[0].ts, t1 = pts[pts.length - 1].ts || t0 + 1;
  const x = (t: number) => P + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * P);
  const y = (v: number) => H - P - (Math.min(v, max) / max) * (H - 2 * P);
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': `${title}: ${series.map((s) => `${s.label} ranges ${Math.min(...vals).toFixed(0)} to ${Math.max(...vals).toFixed(0)}${unit}`).join('; ')}`, preserveAspectRatio: 'none' });
  for (const f of [0, 0.5, 1]) svg.append(sv('line', { x1: '0', x2: String(W), y1: String(H - P - f * (H - 2 * P)), y2: String(H - P - f * (H - 2 * P)), class: 'ch-grid' }));
  series.forEach((s, i) => {
    const segs: string[] = []; let run: string[] = [];
    for (const p of pts) { const v = p[s.key]; if (v === null) { if (run.length) segs.push(run.join(' ')); run = []; } else run.push(`${x(p.ts).toFixed(1)},${y(v).toFixed(1)}`); }
    if (run.length) segs.push(run.join(' '));
    for (const seg of segs) {
      const c = seg.split(' ');
      if (i === 0 && c.length > 1) svg.append(sv('polygon', { points: `${c[0].split(',')[0]},${H - P} ${seg} ${c[c.length - 1].split(',')[0]},${H - P}`, class: `ch-area ${s.cls}` }));
      svg.append(sv('polyline', { points: seg, class: `ch-line ${s.cls}`, fill: 'none' }));
    }
  });
  const legend = h('p', { class: 'legend' }, ...series.map((s) => h('span', { class: `lg ${s.cls}` }, s.label)), h('span', { class: 'mut' }, `max ${max.toFixed(0)}${unit}`));
  const rows = pts.map((p) => [h('span', {}, fmtDateTime(iso(p.ts))), ...series.map((s) => h('span', { class: 'num' }, n(p[s.key], fixed(1, unit))))]);
  const det = h('details', { class: 'chart-data' }, h('summary', {}, 'Show as table'), table(`${title} data`, ['Time', ...series.map((s) => s.label)], rows));
  fig.append(svg, legend, det);
  return fig;
}

let range: MetricRange = '24h';
let chartsBox: HTMLElement;
async function loadCharts() {
  chartsBox.setAttribute('aria-busy', 'true');
  try {
    const pts = await fetchMetrics(range);
    chartsBox.replaceChildren(
      chart('CPU and memory', pts, [{ key: 'cpu', label: 'CPU %', cls: 's1' }, { key: 'mem_pct', label: 'Memory %', cls: 's2' }], '%', 100),
      chart('GPU', pts, [{ key: 'gpu_util', label: 'GPU util %', cls: 's1' }, { key: 'gpu_mem_pct', label: 'GPU memory %', cls: 's2' }], '%', 100),
      chart('AI latency', pts, [{ key: 'latency_ms', label: 'Average ms', cls: 's1' }], ' ms'),
    );
  } catch (e) { failInto(chartsBox, e); }
  chartsBox.setAttribute('aria-busy', 'false');
}
function chartsPanel() {
  chartsBox = h('div', { class: 'charts', 'aria-live': 'polite' });
  const group = h('div', { class: 'row', role: 'group', 'aria-label': 'Time range' });
  for (const r of ['24h', '7d'] as const) {
    const b = h('button', { class: 'btn btn-sm', type: 'button', 'aria-pressed': String(r === range) }, r === '24h' ? 'Last 24 hours' : 'Last 7 days');
    b.addEventListener('click', () => { range = r; group.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); void loadCharts(); });
    group.append(b);
  }
  void loadCharts();
  return panel('Charts', [group, chartsBox]);
}

// ---- sections ----
const none = (t: string) => empty(t);
function statusPanel(x: HubDetail) {
  const s = x.stats ?? {};
  return panel('Status', kv([
    ['Status', h('span', { class: 'row' }, dot(x.online ? 'ok' : 'bad'), x.online ? 'Online' : 'Offline')],
    ['Last seen', x.lastSeen ? `${fmtDateTime(iso(x.lastSeen))} (${ago(iso(x.lastSeen))})` : 'Never'],
    ['Version', `v${x.version}`], ['Edition', x.edition === 'mac' ? 'Hub for Mac' : 'Hub for NVIDIA'], ['Profile', x.profile], ['Update channel', x.updateChannel],
    ['Uptime', n(s.uptime_s, dur)], ['Remote access', x.remoteAccess ? 'On' : 'Off'], ['Paired', fmtDateTime(iso(x.createdAt))],
  ]));
}
function servicesPanel(x: HubDetail) {
  const list = x.stats?.services ?? x.health?.services;
  if (!list?.length) return panel('Services', none('No service report yet.'));
  const rows = list.map((sv2) => [h('span', { class: 'mono' }, sv2[0]), chip(sv2[1], svcTone(sv2[1])), h('span', { class: 'num' }, n(sv2[2] as number | undefined, dur))]);
  return panel('Services', table('Services', ['Service', 'Status', 'Uptime'], rows));
}
function hardwarePanel(s: HubStats | null) {
  if (!s) return panel('Hardware', none('This Hub has not reported hardware numbers yet.'));
  const mem = pct(s.mem_used_mb, s.mem_total_mb), disk = pct(s.disk_used_gb, s.disk_total_gb);
  const kids: Node[] = [
    meter('CPU', s.cpu_pct ?? null, n(s.cpu_pct, fixed(0, '%'))),
    meter('Memory', mem, s.mem_used_mb === undefined || s.mem_total_mb === undefined ? DASH : `${gb(s.mem_used_mb)} of ${gb(s.mem_total_mb)}`),
    meter('Disk', disk, s.disk_used_gb === undefined || s.disk_total_gb === undefined ? DASH : `${s.disk_used_gb.toFixed(0)} of ${s.disk_total_gb.toFixed(0)} GB`),
    kv([['Load (1 min)', n(s.load1, fixed(2))], ['Temperature', n(s.temp_c, fixed(0, ' °C'))]]),
  ];
  for (const g of s.gpu ?? []) {
    kids.push(h('h3', { class: 'sub-h' }, g.name), meter('GPU utilisation', g.util_pct, `${g.util_pct.toFixed(0)}%`),
      meter('GPU memory', pct(g.mem_used_mb, g.mem_total_mb), `${gb(g.mem_used_mb)} of ${gb(g.mem_total_mb)}`), kv([['GPU temperature', n(g.temp_c, fixed(0, ' °C'))]]));
  }
  return panel('Hardware', kids);
}
function aiPanel(s: HubStats | null) {
  const a = s?.ai;
  if (!a) return panel('AI', none('No AI report yet.'));
  const out: Node[] = [kv([['Mode', a.mode === 'local' ? 'Local only' : a.mode === 'local+cloud' ? 'Local with cloud help' : DASH], ['Average response time', n(a.avg_latency_ms, (v) => `${v} ms`)]])];
  if (a.models?.length) out.push(table('Models', ['Lane', 'Model', 'State'], a.models.map((m) => [h('span', {}, m.lane), h('span', { class: 'mono' }, m.name), chip(m.loaded ? 'loaded' : 'idle', m.loaded ? 'green' : 'grey')])));
  return panel('AI', out);
}
function activityPanel(s: HubStats | null) {
  const a = s?.activity ?? {};
  return panel('Activity', [
    kv([['Requests, 24 hours', n(a.requests_24h)], ['Requests, 7 days', n(a.requests_7d)], ['Wake word, 24 hours', n(a.wakes_24h)], ['Approvals waiting', n(a.approvals_pending)], ['Approvals, 24 hours', n(a.approvals_24h)]]),
    h('p', { class: 'note' }, 'Counts only. Albena never sends conversation content.'),
  ]);
}
// ---- usage by module: 24h/7d bars from the latest snapshot, trend sparkline from the stored series ----
const MODULE_LABEL: Record<string, string> = { music: 'Music', home: 'Home', cameras: 'Cameras', media: 'Media', calendar: 'Calendar', email: 'Email', search: 'Search', memory: 'Memory', approvals: 'Approvals', money: 'Money', network: 'Network', desk: 'Service desk', fleet: 'Fleet and agents', chat: 'Chat', other: 'Other' };
const modLabel = (m: string) => MODULE_LABEL[m] ?? m;
function bar(label: string, v: number | undefined, max: number) {
  const w = v === undefined || max <= 0 ? 0 : Math.max(v > 0 ? 2 : 0, Math.round((v / max) * 100));
  const fill = h('span', { class: 'mbar-f' });
  fill.style.width = `${w}%`; // CSSOM, not a style attribute: the portal CSP forbids inline styles
  return h('div', { class: 'mbar', role: 'img', 'aria-label': `${label}: ${n(v)}` }, h('span', { class: 'mbar-l' }, label), h('span', { class: 'mbar-t' }, fill), h('span', { class: 'num mbar-n' }, n(v)));
}
function spark(label: string, pts: ModuleSeries['points']): Node {
  const vals = pts.map((p) => p.requests_24h).filter((v): v is number => v !== null);
  if (pts.length < 2 || vals.length < 2) return h('span', { class: 'mut' }, 'Not enough data');
  const W = 120, H = 28, P = 2, max = Math.max(1, ...vals), t0 = pts[0].ts, t1 = pts[pts.length - 1].ts || t0 + 1;
  const coords = pts.filter((p) => p.requests_24h !== null).map((p) => `${(P + ((p.ts - t0) / Math.max(1, t1 - t0)) * (W - 2 * P)).toFixed(1)},${(H - P - ((p.requests_24h as number) / max) * (H - 2 * P)).toFixed(1)}`).join(' ');
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'spark', role: 'img', 'aria-label': `${label} trend: rolling 24 hour requests from ${Math.min(...vals)} to ${Math.max(...vals)}`, preserveAspectRatio: 'none' });
  svg.append(sv('polyline', { points: coords, class: 'ch-line s1', fill: 'none' }));
  return svg;
}
let modRange: MetricRange = '24h';
let modBox: HTMLElement;
async function loadModuleTrends(snap: Record<string, NonNullable<NonNullable<HubStats['activity']>['modules']>[string]>) {
  modBox.setAttribute('aria-busy', 'true');
  let series: ModuleSeries[] = [];
  let failed = false;
  try { series = await fetchModules(modRange); } catch { failed = true; } // the bars still render from the snapshot
  const byMod = new Map(series.map((s) => [s.module, s.points]));
  const names = Object.keys(snap).sort((a, b) => (snap[b].requests_7d ?? snap[b].requests_24h ?? 0) - (snap[a].requests_7d ?? snap[a].requests_24h ?? 0));
  const max = Math.max(0, ...names.flatMap((m) => [snap[m].requests_7d ?? 0, snap[m].requests_24h ?? 0]));
  const rows = names.map((m) => {
    const s = snap[m];
    return h('li', { class: 'mrow' },
      h('div', { class: 'mrow-h' }, h('strong', {}, modLabel(m)), h('span', { class: 'mut' }, `errors ${n(s.errors_24h)} (24 h) · median ${n(s.p50_ms, (v) => `${v} ms`)}`)),
      h('div', { class: 'mrow-b' }, bar('24 hours', s.requests_24h, max), bar('7 days', s.requests_7d, max)),
      h('div', { class: 'mrow-t' }, spark(modLabel(m), byMod.get(m) ?? [])));
  });
  const trs = names.map((m) => [h('span', {}, modLabel(m)), h('span', { class: 'num' }, n(snap[m].requests_24h)), h('span', { class: 'num' }, n(snap[m].requests_7d)), h('span', { class: 'num' }, n(snap[m].errors_24h)), h('span', { class: 'num' }, n(snap[m].p50_ms))]);
  modBox.replaceChildren(h('ul', { class: 'mlist' }, ...rows), ...(failed ? [h('p', { class: 'note' }, 'Trend lines could not be loaded.')] : []),
    h('details', { class: 'chart-data' }, h('summary', {}, 'Show as table'), table('Usage by module', ['Module', 'Requests 24 h', 'Requests 7 d', 'Errors 24 h', 'Median ms'], trs)));
  modBox.setAttribute('aria-busy', 'false');
}
function modulesPanel(s: HubStats | null) {
  const snap = s?.activity?.modules;
  if (!snap || !Object.keys(snap).length) return panel('Usage by module', none('This Hub does not report usage by module yet. It appears after the Hub updates to a version that sends it.'));
  modBox = h('div', { class: 'modules', 'aria-live': 'polite' });
  const group = h('div', { class: 'row', role: 'group', 'aria-label': 'Trend range' });
  for (const r of ['24h', '7d'] as const) {
    const b = h('button', { class: 'btn btn-sm', type: 'button', 'aria-pressed': String(r === modRange) }, r === '24h' ? 'Trend, 24 hours' : 'Trend, 7 days');
    b.addEventListener('click', () => { modRange = r; group.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); void loadModuleTrends(snap); });
    group.append(b);
  }
  void loadModuleTrends(snap);
  return panel('Usage by module', [group, modBox, h('p', { class: 'note' }, 'Request counts and median response time per module. Counts only; what was said or asked never leaves the Hub.')]);
}
const resultText: Record<string, string> = { ok: 'Succeeded', rolled_back: 'Rolled back', failed: 'Failed', none: 'No update yet' };
function updatesPanel(x: HubDetail) {
  const u = x.stats?.updates ?? {};
  const newer = u.latest_known && u.latest_known !== x.version;
  return panel('Updates', [
    kv([['Installed', `v${x.version}`], ['Latest known', u.latest_known ? `v${u.latest_known}` : DASH], ['Last update', u.last_result ? (resultText[u.last_result] ?? u.last_result) : DASH], ['Last update time', u.last_at ? fmtDateTime(iso(u.last_at)) : DASH]]),
    newer ? h('p', { class: 'note' }, 'A different version is available. The Hub installs updates on its own schedule.') : null,
  ]);
}
function internetPanel(x: HubDetail) {
  const p = x.publicNetwork;
  if (!p) return null; // members never receive it
  const ip: Node | string = p.ip
    ? h('span', { class: 'row' }, h('span', { class: 'mono' }, p.ip), h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': 'Copy public IP address' }, 'Copy'))
    : DASH;
  if (typeof ip !== 'string') ip.lastChild?.addEventListener('click', async () => { try { await navigator.clipboard.writeText(p.ip!); toast('Copied.'); } catch { toast('Copy failed. Select the address and copy it by hand.', true); } });
  const place = [p.city, p.region, p.country].filter(Boolean).join(', ');
  return panel('Internet', [
    kv([
      ['Public IP', ip],
      ['Provider', p.isp ? (p.asn ? `${p.isp} (AS${p.asn})` : p.isp) : p.asn ? `AS${p.asn}` : DASH],
      ['Approx. location', place || DASH],
      ['Last IP change', p.changedAt ? ago(iso(p.changedAt)) : DASH],
    ]),
    h('p', { class: 'note' }, 'Shown only to the account owner to help troubleshoot connectivity.'),
  ]);
}

function render(x: HubDetail, conns: ConnectionsView | null) {
  document.title = `${x.name} | ${staffMode ? 'Hub (staff)' : 'Hubs'} | Albena account`;
  const head = h('div', { class: 'row' }, dot(x.online ? 'ok' : 'bad'), h('h2', { class: 'hub-title' }, x.name), staffMode ? chip('read-only', 'grey') : null,
    h('a', { class: 'btn btn-sm', href: staffMode && x.accountId ? `/support/customers/${encodeURIComponent(x.accountId)}` : '/hubs' }, staffMode ? 'Back to customer' : 'All Hubs'));
  const banner = x.online ? null : h('div', { class: 'banner is-warn', role: 'alert' }, h('span', {}, `This Hub is offline. It last reported ${x.lastSeen ? ago(iso(x.lastSeen)) : 'never'}. Numbers below are its last known state.`));
  root.replaceChildren(h('div', { class: 'stack' }, head, banner, h('div', { class: 'grid-2' }, statusPanel(x), updatesPanel(x)), internetPanel(x), conns ? connectionsPanel(conns, x.id, staffMode) : null, servicesPanel(x),
    h('div', { class: 'grid-2' }, hardwarePanel(x.stats), aiPanel(x.stats)), activityPanel(x.stats), modulesPanel(x.stats), chartsPanel()));
}

if (!id) failInto(root, new Error('missing id'));
else fetchHub().then(async (x) => {
  // The Connections panel is optional: if it cannot load, the rest of the page still renders.
  const conns = await (staffMode ? (x.accountId ? staff.connectors(x.accountId) : Promise.reject(new Error('no account'))) : api.connectors()).catch(() => null);
  root.setAttribute('aria-busy', 'false'); render(x, conns);
}).catch((e) => failInto(root, e));
