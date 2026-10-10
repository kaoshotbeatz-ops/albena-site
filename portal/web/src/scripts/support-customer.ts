// Staff customer detail: /support/customers/<id>. All data via /api/support/accounts/:id; every action is audited server side.
import { h, must, chip, fmtDateTime, failInto, empty, table, panel, run, confirmDialog, toast, money } from '../lib/ui';
import { field, formDialog, planFields, secretDialog, PLAN_NAMES } from '../lib/forms';
import { staff, type Detail } from '../lib/staff';

document.documentElement.classList.add('js');
const root = must('#root');
const id = decodeURIComponent(location.pathname.split('/')[3] ?? '');
const at = (s: number | null | undefined) => (s ? fmtDateTime(new Date(s * 1000).toISOString()) : '');
const txt = (s: string) => document.createTextNode(s);
const flush = (p: HTMLElement) => { p.querySelector('.panel-body')?.classList.add('flush'); return p; };
const entTone = (s: string) => (s === 'active' || s === 'trialing' ? 'green' : s === 'suspended' || s === 'past_due' ? 'red' : s === 'expired' ? 'amber' : 'grey');
const orderTone = (s: string) => (s === 'delivered' ? 'green' : s === 'shipped' ? 'indigo' : s === 'cancelled' ? 'red' : 'amber');
const btn = (label: string, fn: (b: HTMLButtonElement) => void | Promise<void>, cls = 'btn btn-sm', aria?: string) => {
  const b = h('button', { class: cls, type: 'button', 'aria-label': aria }, label);
  b.addEventListener('click', () => fn(b));
  return b;
};

let d: Detail;
async function reload() {
  try { d = await staff.account(id); root.setAttribute('aria-busy', 'false'); render(); }
  catch (e) { failInto(root, e); }
}
const act = async (b: HTMLButtonElement | null, fn: () => Promise<unknown>, msg: string) => { if (await run(b, fn, msg) !== undefined) await reload(); };

async function grantDialog() {
  const e = d.entitlement;
  const plans = planFields({ defaultPlan: e.source === 'manual' && e.plan !== 'none' ? (e.comp ? 'comp' : e.plan) : 'pilot' });
  if (await formDialog('Grant or extend a plan', 'Sets the plan by hand. A live Stripe subscription cannot be overwritten; if the customer starts paying, Stripe takes over and this grant is archived.', plans.nodes, 'Save plan', async () => {
    const fragment = plans.value();
    if (typeof fragment === 'string') return fragment;
    await staff.grant(id, fragment); toast('Plan saved.');
  })) await reload();
}

async function orderDialog() {
  const edition = field('Hub edition', 'select', { options: [['mac', 'Mac'], ['nvidia', 'NVIDIA']] });
  const notes = field('Notes', 'textarea', { rows: '3', placeholder: 'Ship-to, gift, anything the packer needs (staff only)' });
  if (await formDialog('Create hardware order', 'A manual order starts as pending. The customer sees its status and tracking in their portal.', [edition.wrap, notes.wrap], 'Create order', async () => {
    await staff.createOrder(id, edition.el.value, notes.el.value.trim()); toast('Order created.');
  })) await reload();
}

async function reserveDialog() {
  const serial = field('Hub serial', 'input', { required: true, placeholder: 'ALB-0001', hint: 'Printed on the device. 4 to 64 letters, digits, dot, dash, underscore.' });
  const edition = field('Hub edition', 'select', { options: [['mac', 'Mac'], ['nvidia', 'NVIDIA']] });
  const name = field('Hub name (optional)', 'input', { placeholder: 'Kitchen Hub' });
  const key = field('Hub public key (optional)', 'input', { placeholder: 'base64 Ed25519 key', hint: 'When known, only a Hub with this key can bind. Recommended: a serial alone is an identifier, not a secret.' });
  const days = field('Valid for (days)', 'input', { type: 'number', value: '60', min: '1', max: '365' });
  if (await formDialog('Reserve a Hub for this account', 'The Hub binds itself when it presents this serial during setup. No pairing code needed. Single use.', [serial.wrap, edition.wrap, name.wrap, key.wrap, days.wrap], 'Reserve', async () => {
    await staff.reserveHub(id, { serial: serial.el.value.trim(), edition: edition.el.value, days: Number(days.el.value), ...(name.el.value.trim() ? { name: name.el.value.trim() } : {}), ...(key.el.value.trim() ? { publicKey: key.el.value.trim() } : {}) });
    toast('Hub reserved.');
  })) await reload();
}

async function keyDialog() {
  const label = field('Label (optional)', 'input', { placeholder: 'Dana’s Mac mini' });
  if (await formDialog('Generate a license key', 'BYO Hubs can pair with this key instead of a code. It is shown once.', [label.wrap], 'Generate', async () => {
    const r = await staff.mintKey(id, label.el.value.trim());
    await secretDialog('License key', r.licenseKey, 'Shown once. Give it to the customer now; only a hash is kept and it cannot be shown again.');
  })) await reload();
}

async function shipDialog(orderId: string) {
  const carrier = field('Carrier', 'input', { required: true, placeholder: 'UPS' });
  const tracking = field('Tracking number', 'input', { required: true });
  if (await formDialog('Mark as shipped', null, [carrier.wrap, tracking.wrap], 'Mark shipped', async () => {
    if (!carrier.el.value.trim() || !tracking.el.value.trim()) return 'Carrier and tracking number are required.';
    await staff.patchOrder(orderId, { status: 'shipped', carrier: carrier.el.value.trim(), tracking: tracking.el.value.trim() }); toast('Order shipped.');
  })) await reload();
}

function head() {
  const e = d.entitlement, owner = d.users.find((u) => u.role === 'owner');
  const actions = h('div', { class: 'row' },
    h('a', { class: 'btn btn-sm', href: `/support/view-as?account=${encodeURIComponent(id)}` }, 'View as'),
    btn('Grant / extend plan', () => void grantDialog(), 'btn btn-sm btn-primary'),
    e.source === 'manual' && e.plan !== 'none' && (e.status === 'active'
      ? btn('Suspend', async (b) => { if (await confirmDialog('Suspend this plan?', 'Access stops now and pending pairing codes are dropped. Hubs already paired stay registered.', 'Suspend', { danger: true })) await act(b, () => staff.grant(id, { status: 'suspended' }), 'Plan suspended.'); }, 'btn btn-sm btn-danger')
      : btn('Reactivate', (b) => act(b, () => staff.grant(id, { status: 'active' }), 'Plan reactivated.'), 'btn btn-sm')),
    btn('Create order', () => void orderDialog()),
    btn('Reserve a Hub', () => void reserveDialog()),
    e.plan === 'byo' && btn('License key', () => void keyDialog()),
    (() => { const inv = d.invites.find((i) => !i.acceptedAt && !i.revokedAt); return inv ? btn('Resend invite', (b) => act(b, () => staff.resendInvite(inv.id), 'Invite sent again.')) : null; })());
  return panel(owner?.email ?? d.account.ownerEmail, [
    h('div', { class: 'row' }, chip(PLAN_NAMES[e.plan] ?? e.plan, 'indigo'), chip(e.comp ? `${e.status}, complimentary` : e.status, entTone(e.status)), chip(e.source, e.source === 'manual' ? 'indigo' : 'grey'), h('span', { class: 'mono mut' }, d.account.id)),
    actions,
  ]);
}

function planPanel() {
  const e = d.entitlement;
  return panel('Plan', h('dl', { class: 'kv' },
    h('dt', {}, 'Plan'), h('dd', {}, `${PLAN_NAMES[e.plan] ?? e.plan}${e.comp ? ' (complimentary)' : ''}`),
    h('dt', {}, 'Status'), h('dd', {}, e.status + (e.active ? '' : e.status === 'expired' ? ' (end date passed)' : '')),
    h('dt', {}, 'Source'), h('dd', {}, e.source === 'stripe' ? 'Stripe subscription' : 'Set by staff'),
    h('dt', {}, 'Ends'), h('dd', {}, e.endsAt ? at(e.endsAt) : 'No end date'),
    h('dt', {}, 'Hub allowance'), h('dd', {}, String(e.maxHubs)),
    h('dt', {}, 'Staff note'), h('dd', {}, e.note ?? '')));
}

function usersPanel() {
  return flush(panel('People', h('ul', { class: 'list' }, ...d.users.map((u) => h('li', {}, h('div', { class: 'main' }, h('span', { class: 'name' }, u.email), u.name ? h('span', { class: 'sub' }, u.name) : null), chip(u.role, u.role === 'owner' ? 'indigo' : 'grey'))))));
}

function hubsPanel() {
  const online = (s: number | null) => s !== null && Date.now() / 1000 - s < 900;
  const hubs = d.hubs.length ? flush(panel('Hubs', table('Hubs', ['Name', 'Edition', 'Version', 'Health', 'Last seen', 'Paired'], d.hubs.map((x) => [
    h('a', { href: `/support/hubs/${encodeURIComponent(x.id)}`, 'aria-label': `Open Hub ${x.name}` }, x.name), txt(x.edition), h('span', { class: 'mono' }, x.version),
    chip(x.health === null ? 'no report' : x.health.ok ? 'healthy' : 'degraded', x.health === null ? 'grey' : x.health.ok ? 'green' : 'amber'),
    txt(x.lastSeen ? `${at(x.lastSeen)}${online(x.lastSeen) ? ' (online)' : ''}` : 'never'), txt(at(x.createdAt)),
  ])))) : panel('Hubs', empty('No Hubs paired.'));
  const res = d.reservedHubs.length ? flush(panel('Reserved Hubs', table('Reserved Hubs', ['Serial', 'Edition', 'Status', 'Expires', ''], d.reservedHubs.map((r) => [
    h('span', { class: 'mono' }, r.serial), txt(r.edition),
    chip(r.usedAt ? 'bound' : r.expiresAt <= Date.now() / 1000 ? 'expired' : 'waiting', r.usedAt ? 'green' : r.expiresAt <= Date.now() / 1000 ? 'grey' : 'amber'), txt(at(r.expiresAt)),
    r.usedAt ? txt('') : btn('Cancel', async (b) => { if (await confirmDialog('Cancel this reservation?', `${r.serial} will no longer bind to this account.`, 'Cancel reservation', { danger: true })) await act(b, () => staff.cancelReserved(r.id), 'Reservation cancelled.'); }, 'btn btn-sm btn-danger', `Cancel reservation ${r.serial}`),
  ])))) : null;
  return [hubs, res];
}

function ordersPanel() {
  if (!d.orders.length) return panel('Orders', empty('No hardware orders.'));
  return flush(panel('Orders', table('Orders', ['Order', 'Source', 'Item', 'Status', 'Tracking', 'Placed', 'Notes', ''], d.orders.map((o) => {
    const acts: Node[] = [];
    if (o.source === 'manual') {
      if (o.status === 'pending') acts.push(btn('Preparing', (b) => act(b, () => staff.patchOrder(o.id, { status: 'preparing' }), 'Order updated.')));
      if (o.status === 'preparing') acts.push(btn('Shipped', () => void shipDialog(o.id)));
      if (o.status === 'shipped') acts.push(btn('Delivered', (b) => act(b, () => staff.patchOrder(o.id, { status: 'delivered' }), 'Order delivered.')));
      if (o.status === 'pending' || o.status === 'preparing') acts.push(btn('Cancel', async (b) => { if (await confirmDialog('Cancel this order?', 'The customer will see it as cancelled. Refunds are handled separately.', 'Cancel order', { danger: true })) await act(b, () => staff.patchOrder(o.id, { status: 'cancelled' }), 'Order cancelled.'); }, 'btn btn-sm btn-danger'));
    }
    return [h('span', { class: 'mono' }, o.id), txt(o.source), txt(o.edition ?? o.plan), chip(o.status.replace(/_/g, ' '), orderTone(o.status)),
      txt(o.carrier ? `${o.carrier} ${o.tracking ?? ''}` : ''), txt(at(o.createdAt) + (o.amountTotal ? ` · ${money(o.amountTotal, o.currency ?? 'usd')}` : '')), txt(o.notes ?? ''), h('div', { class: 'row' }, ...acts)];
  }))));
}

function keysPanel() {
  if (!d.licenseKeys.length) return null;
  return flush(panel('License keys', table('License keys', ['Key', 'Label', 'Created', 'Last used', 'Uses', ''], d.licenseKeys.map((k) => [
    h('span', { class: 'mono' }, `ALB-…${k.hint}`), txt(k.label ?? ''), txt(at(k.createdAt)), txt(k.lastUsedAt ? at(k.lastUsedAt) : 'never'), h('span', { class: 'num' }, String(k.useCount)),
    k.revokedAt ? chip('revoked', 'red') : btn('Revoke', async (b) => { if (await confirmDialog('Revoke this license key?', 'Hubs cannot pair with it anymore. Hubs already paired are not affected.', 'Revoke', { danger: true })) await act(b, () => staff.revokeKey(k.id), 'Key revoked.'); }, 'btn btn-sm btn-danger', `Revoke key ending ${k.hint}`),
  ]))));
}

function notesPanel() {
  const ta = field('Add a note', 'textarea', { rows: '3', placeholder: 'Staff only. Notes cannot be edited or deleted.' });
  const add = h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Add note');
  const form = h('form', { class: 'stack', novalidate: true }, ta.wrap, h('div', { class: 'row' }, add));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!ta.el.value.trim()) return;
    await act(add, () => staff.addNote(id, ta.el.value.trim()), 'Note added.');
  });
  return panel('Notes', [form, d.notes.length ? h('ul', { class: 'list' }, ...d.notes.map((n) => h('li', {}, h('div', { class: 'main' }, h('span', { class: 'name' }, n.body), h('span', { class: 'sub' }, `${n.actor.replace('support:', '')} · ${at(n.at)}`))))) : empty('No notes yet.')]);
}

function historyPanel() {
  if (!d.history.length) return panel('Plan history', empty('No manual plan changes.'));
  return flush(panel('Plan history', table('Plan history', ['When', 'Change', 'Plan', 'Status', 'Ends', 'By', 'Note'], d.history.map((x) => [
    txt(at(x.at)), chip(x.kind.replace(/_/g, ' '), 'grey'), txt(x.plan ?? ''), txt(x.status ?? ''), txt(x.endsAt ? at(x.endsAt) : ''), txt(x.actor.replace('support:', '')), txt(x.note ?? ''),
  ]))));
}

function invitesPanel() {
  if (!d.invites.length) return null;
  const status = (i: Detail['invites'][number]) => (i.acceptedAt ? 'accepted' : i.revokedAt ? 'revoked' : i.expiresAt <= Date.now() / 1000 ? 'expired' : 'pending');
  return flush(panel('Invites', table('Invites', ['Email', 'Plan', 'Status', 'Sent', 'Expires'], d.invites.map((i) => [
    txt(i.email), txt(i.plan ?? 'none'), chip(status(i), status(i) === 'pending' ? 'amber' : status(i) === 'accepted' ? 'green' : 'grey'), txt(`${at(i.createdAt)}${i.sendCount > 1 ? ` (x${i.sendCount})` : ''}`), txt(at(i.expiresAt)),
  ]))));
}

function auditPanel() {
  if (!d.audit.length) return panel('Audit timeline', empty('Nothing recorded.'));
  return flush(panel('Audit timeline', h('div', { class: 'timeline' }, table('Audit timeline', ['When', 'Who', 'Action'], d.audit.map((a) => [
    txt(fmtDateTime(a.ts)), txt(a.actor.replace('support:', 'staff ')), h('span', { class: 'mono' }, a.action),
  ])))));
}

function render() {
  document.title = `${d.account.ownerEmail} (staff) | Albena account`;
  const parts: (HTMLElement | null)[] = [head(), h('div', { class: 'grid-2' }, planPanel(), usersPanel()), ...hubsPanel(), ordersPanel(), keysPanel(), historyPanel(), notesPanel(), invitesPanel(), auditPanel()];
  root.replaceChildren(h('div', { class: 'stack' }, ...parts.filter((p): p is HTMLElement => p !== null)));
}

if (!id) failInto(root, new Error('missing id')); else reload();
