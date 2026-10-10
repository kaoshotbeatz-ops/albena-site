import './shell';
import { api } from '../lib/api';
import { h, must, $, panel, chip, dot, ago, fmtDateTime, failInto, run, toast, confirmDialog, empty } from '../lib/ui';
import type { Hub, PairStart } from '../lib/types';

const root = must('#root');
const pairRoot = must('#pair');
let hubs: Hub[] = [];
let selected: string | null = null;
let timer: number | undefined;

const editionLabel = (e: string) => (e === 'mac' ? 'Hub for Mac' : e === 'nvidia' ? 'Hub for NVIDIA' : e);

function bar(label: string, pct: number | null, text: string) {
  return h('span', { class: 'mini' }, h('span', { class: 'mini-l' }, label),
    pct === null ? h('span', { class: 'mini-na' }, '—') : h('meter', { class: 'meter', min: '0', max: '100', value: String(Math.round(pct)), 'aria-label': `${label} ${text}` }),
    h('span', { class: 'num' }, text));
}
function miniBars(x: Hub) {
  const s = x.summary;
  if (!s) return null;
  const mem = s.mem_used_mb !== null && s.mem_total_mb ? (s.mem_used_mb / s.mem_total_mb) * 100 : null;
  return h('span', { class: 'minis' }, bar('CPU', s.cpu_pct, s.cpu_pct === null ? '—' : `${Math.round(s.cpu_pct)}%`), bar('Memory', mem, mem === null ? '—' : `${Math.round(mem)}%`));
}

function renderList() {
  if (!hubs.length) {
    root.replaceChildren(panel('Your Hubs', empty('No Hubs paired yet. Use “Pair a new Hub” to connect one.')));
    return;
  }
  const ul = h('ul', { class: 'list' });
  for (const x of hubs) {
    const open = h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': `Manage ${x.name}` }, 'Manage');
    open.addEventListener('click', () => select(x.id, true));
    const view = h('a', { class: 'btn btn-sm', href: `/hubs/${encodeURIComponent(x.id)}`, 'aria-label': `Details for ${x.name}` }, 'Details');
    ul.append(h('li', {},
      h('div', { class: 'main' }, h('span', { class: 'name' }, dot(x.online ? 'ok' : x.health === 'degraded' ? 'warn' : 'bad'), x.name),
        h('span', { class: 'sub' }, `${editionLabel(x.edition)} · v${x.version} · ${x.online ? 'Online' : `Offline, last seen ${ago(x.lastSeenAt)}`}`),
        miniBars(x)),
      h('div', { class: 'row' }, x.remoteAccess && chip('Remote access on', 'amber'), view, open)));
  }
  const detail = h('div', { id: 'detail', tabindex: '-1', 'aria-live': 'polite' });
  root.replaceChildren(h('div', { class: 'stack' }, panel('Your Hubs', h('div', {}, ul)), detail));
  const body = ul.closest('.panel-body'); body?.classList.add('flush');
  if (selected) renderDetail(false);
}

function select(id: string, focus: boolean) { selected = id; renderDetail(focus); }

function renderDetail(focus: boolean) {
  const x = hubs.find((v) => v.id === selected);
  const box = $('#detail');
  if (!x || !box) return;
  const name = h('input', { class: 'input', id: 'hub-name', value: x.name, maxlength: '60', autocomplete: 'off' });
  const chan = h('select', { class: 'select', id: 'hub-chan' },
    h('option', { value: 'stable' }, 'Stable (recommended)'), h('option', { value: 'beta' }, 'Beta (early features)'));
  chan.value = x.updateChannel;
  const save = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Save changes');
  save.addEventListener('click', async () => {
    const nm = name.value.trim();
    if (!nm) { toast('Name cannot be empty.', true); name.focus(); return; }
    const r = await run(save, () => api.hubPatch(x.id, { name: nm, updateChannel: chan.value as Hub['updateChannel'] }), 'Hub updated');
    if (r) { Object.assign(x, r); renderList(); }
  });

  const remote = h('input', { type: 'checkbox', id: 'hub-remote', 'aria-describedby': 'remote-warn' });
  remote.checked = x.remoteAccess;
  const warn = h('p', { class: 'note warn', id: 'remote-warn', hidden: !x.remoteAccess },
    'Remote access lets you reach this Hub away from home through an encrypted relay. Only turn it on if you need it; anyone who can sign in to this account could use it. Your conversations and camera data still stay on the Hub.');
  remote.addEventListener('change', async () => {
    if (remote.checked) {
      const ok = await confirmDialog('Turn on remote access?', 'This lets signed-in members of your account reach this Hub from outside your home network. You can turn it off any time.', 'Turn on');
      if (!ok) { remote.checked = false; return; }
    }
    const r = await run(null, () => api.hubPatch(x.id, { remoteAccess: remote.checked }), remote.checked ? 'Remote access on' : 'Remote access off');
    if (r) { Object.assign(x, r); warn.hidden = !x.remoteAccess; renderList(); } else { remote.checked = x.remoteAccess; }
  });

  const unpair = h('button', { class: 'btn btn-danger btn-sm', type: 'button' }, 'Unpair this Hub');
  unpair.addEventListener('click', async () => {
    const ok = await confirmDialog(`Unpair ${x.name}?`, 'The Hub will lose its link to your account and stop receiving updates. It keeps working locally. You can pair it again later with a new code.', 'Unpair', { danger: true });
    if (!ok) return;
    if (await run(unpair, () => api.hubDelete(x.id), 'Hub unpaired') !== undefined) { hubs = hubs.filter((v) => v.id !== x.id); selected = null; renderList(); }
  });

  box.replaceChildren(panel(x.name, [
    h('dl', { class: 'kv' },
      h('dt', {}, 'Edition'), h('dd', {}, editionLabel(x.edition)),
      h('dt', {}, 'Version'), h('dd', { class: 'num' }, `v${x.version}`),
      h('dt', {}, 'Profile'), h('dd', {}, x.profile),
      h('dt', {}, 'Status'), h('dd', {}, x.online ? 'Online' : 'Offline'),
      h('dt', {}, 'Last seen'), h('dd', {}, x.lastSeenAt ? fmtDateTime(x.lastSeenAt) : 'Never')),
    h('div', { class: 'field' }, h('label', { for: 'hub-name' }, 'Name'), name),
    h('div', { class: 'field' }, h('label', { for: 'hub-chan' }, 'Update channel'), chan),
    h('div', { class: 'row' }, save),
    h('div', { class: 'switch' }, remote, h('label', { for: 'hub-remote' }, 'Remote access', h('span', { class: 'hint' }, 'Off by default. Reach this Hub when you are away from home.'))),
    warn,
    h('div', { class: 'row end' }, unpair),
  ]));
  if (focus) { box.focus(); box.scrollIntoView({ block: 'start' }); }
}

// ---- pairing flow ----
function stopTimer() { if (timer) { clearInterval(timer); timer = undefined; } }
function renderPair(p: PairStart) {
  stopTimer();
  const end = Date.parse(p.expiresAt);
  const count = h('span', { class: 'num', role: 'timer' });
  const live = h('p', { class: 'sr', 'aria-live': 'polite', role: 'status' });
  const again = h('button', { class: 'btn btn-sm', type: 'button' }, 'Get a new code');
  const cancel = h('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, 'Close');
  const code = h('p', { class: 'code', 'aria-label': `Pairing code ${p.code.split('').join(' ')}` }, p.code);
  const tick = () => {
    const left = Math.max(0, Math.round((end - Date.now()) / 1000));
    count.textContent = left ? `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Code expired';
    if (!left) { code.classList.add('mut'); stopTimer(); live.textContent = 'The pairing code has expired.'; }
  };
  again.addEventListener('click', startPair);
  cancel.addEventListener('click', () => { stopTimer(); pairRoot.replaceChildren(); });
  pairRoot.replaceChildren(panel('Pair a new Hub', [
    h('p', { class: 'mut' }, 'Enter this code on your Hub to link it to your account.'),
    code,
    h('p', { class: 'row' }, chip('Single use', 'grey'), count),
    h('ol', { class: 'steps' },
      h('li', {}, 'Open Albena on your Hub and choose Settings, then Link to account.'),
      h('li', {}, 'Type the 8-character code above exactly as shown.'),
      h('li', {}, 'Wait for the confirmation. The Hub appears in this list within a minute.')),
    live,
    h('div', { class: 'row' }, again, cancel),
  ]));
  tick();
  timer = window.setInterval(tick, 1000);
  // Poll for the new Hub while the code is live.
  const before = new Set(hubs.map((v) => v.id));
  const poll = window.setInterval(async () => {
    if (!timer) { clearInterval(poll); return; }
    try {
      const now = await api.hubs();
      const fresh = now.find((v) => !before.has(v.id));
      if (fresh) { hubs = now; clearInterval(poll); stopTimer(); pairRoot.replaceChildren(); selected = fresh.id; renderList(); toast(`${fresh.name} paired`); }
    } catch { /* keep trying */ }
  }, 5000);
}
async function startPair() {
  const btn = $<HTMLButtonElement>('#pair-btn');
  const p = await run(btn, () => api.pairStart());
  if (p) { renderPair(p); must('#pair .code').scrollIntoView({ block: 'center' }); }
}
must('#pair-btn').addEventListener('click', startPair);

api.hubs().then((v) => {
  hubs = v;
  root.setAttribute('aria-busy', 'false');
  renderList();
  if (location.hash === '#pair') startPair();
}).catch((e) => failInto(root, e));
