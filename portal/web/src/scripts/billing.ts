import './shell';
import { api } from '../lib/api';
import { h, must, panel, chip, fmtDate, money, failInto, run, safeRedirect, table, empty } from '../lib/ui';
import type { BillingSummary, Interval, PlanId } from '../lib/types';

const root = must('#root');
const PLANS: { id: PlanId; name: string; blurb: string }[] = [
  { id: 'byo', name: 'Bring your own', blurb: 'Run Albena on hardware you already own.' },
  { id: 'hub_mac', name: 'Hub for Mac', blurb: 'Always-on Hub tuned for Apple silicon.' },
  { id: 'hub_nvidia', name: 'Hub for NVIDIA', blurb: 'Maximum local model performance.' },
  { id: 'estate', name: 'Estate', blurb: 'Multiple Hubs and household members for larger homes.' },
];

async function openPortal(btn: HTMLButtonElement) {
  const r = await run(btn, () => api.portal());
  if (r) safeRedirect(r.url);
}

function planPanel(b: BillingSummary) {
  const none = b.plan === 'none';
  if (b.source === 'manual' && !none) {
    // Set up by the Albena team: there is no Stripe subscription, so no billing portal.
    const live = b.status === 'active';
    return panel('Current plan', [
      h('p', { class: 'big' }, b.planName),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Status'), h('dd', {}, chip(live ? 'Active' : b.status, live ? 'green' : 'grey')),
        h('dt', {}, b.status === 'expired' ? 'Ended' : 'Ends'), h('dd', {}, b.endsAt ? fmtDate(b.endsAt) : 'No end date')),
      h('p', { class: 'mut' }, live ? 'This plan was set up for you by the Albena team, so there is nothing to pay or manage here. Questions? Use Support.' : 'This plan is not active. Contact the Albena team, or choose a plan below.'),
    ]);
  }
  const portal = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Manage billing');
  portal.addEventListener('click', () => openPortal(portal));
  const tone = b.status === 'active' || b.status === 'trialing' ? 'green' : b.status === 'past_due' ? 'red' : 'grey';
  return panel('Current plan', [
    h('p', { class: 'big' }, none ? 'No plan yet' : b.planName),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Status'), h('dd', {}, chip(none ? 'Not subscribed' : b.status.replace('_', ' '), tone)),
      !none && h('dt', {}, 'Billing'), !none && h('dd', { class: 'num' }, b.interval === 'annual' ? 'Billed yearly' : 'Billed monthly'),
      !none && h('dt', {}, b.cancelAtPeriodEnd ? 'Ends' : 'Renews'), !none && h('dd', {}, fmtDate(b.renewsAt))),
    b.status === 'past_due' && h('p', { class: 'banner is-error', role: 'alert' }, 'Your last payment failed. Use Manage billing to update your payment method.'),
    h('p', { class: 'mut' }, 'Payment methods, receipts and cancellation are handled securely by Stripe. Albena never sees your card number.'),
    h('div', { class: 'row' }, portal),
  ]);
}

function plansPanel(current: string) {
  let interval: Interval = 'monthly';
  const seg = h('div', { class: 'row', role: 'group', 'aria-label': 'Billing interval' });
  const grid = h('div', { class: 'grid-3' });
  const mkSeg = (i: Interval, t: string) => {
    const b = h('button', { class: 'btn btn-sm', type: 'button', 'aria-pressed': String(i === interval) }, t);
    b.addEventListener('click', () => { interval = i; seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); });
    return b;
  };
  seg.append(mkSeg('monthly', 'Monthly'), mkSeg('annual', 'Yearly'));
  for (const p of PLANS) {
    const isCur = p.id === current;
    const go = h('button', { class: `btn btn-sm ${isCur ? '' : 'btn-primary'}`.trim(), type: 'button', 'aria-label': `${isCur ? 'Current plan' : current === 'none' ? 'Choose' : 'Switch to'} ${p.name}` }, isCur ? 'Current plan' : current === 'none' ? 'Choose plan' : 'Switch plan');
    if (isCur) go.disabled = true;
    go.addEventListener('click', async () => {
      const r = await run(go, () => api.checkout(p.id, interval));
      if (r) safeRedirect(r.url);
    });
    grid.append(h('div', { class: 'perk' }, h('h3', {}, p.name), h('p', {}, p.blurb), go));
  }
  return panel(current === 'none' ? 'Choose a plan' : 'Change plan', [seg, grid, h('p', { class: 'mut' }, 'You will review the price on Stripe’s secure checkout before anything is charged.')]);
}

function invoicesPanel(list: Awaited<ReturnType<typeof api.invoices>>) {
  if (!list.length) return panel('Invoices', empty('No invoices yet.'));
  const rows = list.map((i) => [
    h('span', { class: 'mono' }, i.number), document.createTextNode(fmtDate(i.date)),
    h('span', { class: 'num' }, money(i.amount, i.currency)),
    chip(i.status, i.status === 'paid' ? 'green' : i.status === 'open' ? 'amber' : 'grey'),
    i.url !== null ? h('a', { class: 'tlink', href: i.url, target: '_blank', rel: 'noopener noreferrer' }, 'View', h('span', { class: 'sr' }, ` invoice ${i.number}`)) : document.createTextNode(''),
  ]);
  const p = panel('Invoices', table('Invoices', ['Number', 'Date', 'Amount', 'Status', ''], rows));
  p.querySelector('.panel-body')?.classList.add('flush');
  return p;
}

(async () => {
  const [b, inv] = await Promise.allSettled([api.billing(), api.invoices()]);
  if (b.status === 'rejected') throw b.reason;
  root.replaceChildren(h('div', { class: 'stack' },
    planPanel(b.value), ...(b.value.source === 'manual' && b.value.status === 'active' ? [] : [plansPanel(b.value.plan)]),
    inv.status === 'fulfilled' ? invoicesPanel(inv.value) : panel('Invoices', h('p', { class: 'is-error' }, 'Could not load invoices.'))));
  root.setAttribute('aria-busy', 'false');
})().catch((e) => failInto(root, e));
