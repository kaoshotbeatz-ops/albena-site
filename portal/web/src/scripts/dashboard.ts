import './shell';
import { api } from '../lib/api';
import { h, must, panel, chip, dot, fmtDate, ago, failInto, empty } from '../lib/ui';
import type { BillingSummary, Hub } from '../lib/types';

const root = must('#root');
const statusTone = (s: BillingSummary['status']) => (s === 'active' || s === 'trialing' ? 'green' : s === 'past_due' ? 'red' : 'grey');

function planCard(b: BillingSummary) {
  const none = b.plan === 'none';
  return panel('Plan', [
    h('p', { class: 'big' }, none ? 'No plan yet' : b.planName),
    h('div', { class: 'row' }, chip(none ? 'Not subscribed' : b.status.replace('_', ' '), none ? 'grey' : statusTone(b.status)),
      !none && h('span', { class: 'mut' }, b.interval === 'annual' ? 'Billed yearly' : 'Billed monthly')),
    h('a', { class: 'btn btn-sm', href: '/billing' }, none ? 'Choose a plan' : 'Manage plan'),
  ]);
}
function renewalCard(b: BillingSummary) {
  const d = b.renewsAt;
  return panel('Renewal', [
    h('p', { class: 'big num' }, d ? fmtDate(d) : 'None'),
    h('p', { class: 'mut' }, !d ? 'No upcoming renewal.' : b.cancelAtPeriodEnd ? 'Your plan ends on this date and will not renew.' : 'Your plan renews automatically.'),
  ]);
}
function hubsCard(hubs: Hub[]) {
  const online = hubs.filter((x) => x.online).length;
  const body: Node[] = [h('p', { class: 'big num' }, hubs.length ? `${online} of ${hubs.length} online` : 'No Hubs yet')];
  if (hubs.length) {
    body.push(h('ul', { class: 'stack' },
      ...hubs.slice(0, 4).map((x) => h('li', { class: 'row' }, dot(x.online ? 'ok' : x.health === 'degraded' ? 'warn' : 'bad'), h('span', {}, x.name),
        h('span', { class: 'mut' }, x.online ? `v${x.version}` : `last seen ${ago(x.lastSeenAt)}`)))));
  } else body.push(h('p', { class: 'mut' }, 'Pair your first Hub to see it here.'));
  return panel('Hubs', body, h('a', { class: 'tlink', href: '/hubs' }, 'View all'));
}
function alertsCard(b: BillingSummary | undefined, hubs: Hub[]) {
  const msgs: string[] = [];
  if (b?.status === 'past_due') msgs.unshift('Your last payment failed. Update your payment method in Billing.');
  for (const x of hubs) if (!x.online && true) msgs.push(`${x.name} is offline (last seen ${ago(x.lastSeenAt)}).`);
  return panel('Alerts', msgs.length ? h('ul', { class: 'stack' }, ...msgs.map((m) => h('li', { class: 'banner is-warn' }, m))) : empty('All clear. Nothing needs your attention.'));
}
function quick() {
  const link = (href: string, t: string, primary = false) => h('a', { class: `btn ${primary ? 'btn-primary' : ''}`.trim(), href }, t);
  return panel('Quick actions', h('div', { class: 'row' }, link('/hubs#pair', 'Pair a new Hub', true), link('/downloads', 'Download installer'), link('/billing', 'View invoices'), link('/household', 'Invite someone'), link('/security', 'Add a passkey')));
}

async function main() {
  const [b, hubs] = await Promise.allSettled([api.billing(), api.hubs()]);
  if (b.status === 'rejected' && hubs.status === 'rejected') throw b.reason;
  const bs = b.status === 'fulfilled' ? b.value : undefined;
  const hs = hubs.status === 'fulfilled' ? hubs.value : [];
  const unavailable = (t: string) => panel(t, h('p', { class: 'mut is-error' }, 'Could not load this right now.'));
  root.replaceChildren(
    h('div', { class: 'grid-3 mb' }, bs ? planCard(bs) : unavailable('Plan'), hubsCard(hs), bs ? renewalCard(bs) : unavailable('Renewal')),
    h('div', { class: 'grid-2' }, alertsCard(bs, hs), quick()),
  );
  root.setAttribute('aria-busy', 'false');
}
main().catch((e) => failInto(root, e));
