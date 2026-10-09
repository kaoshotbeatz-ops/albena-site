// Staff-only list (Cloudflare Access gates this page and /api/support/*). No customer session needed.
import { api } from '../lib/api';
import { h, must, chip, fmtDate, failInto, empty, table } from '../lib/ui';

document.documentElement.classList.add('js');
const root = must('#root');
const q = must<HTMLInputElement>('#q');

api.supportAccounts().then(({ me, accounts }) => {
  root.setAttribute('aria-busy', 'false');
  const render = () => {
    const term = q.value.trim().toLowerCase();
    const rows = accounts.filter((a) => !term || [a.email, a.id, a.plan, a.status].some((v) => v.toLowerCase().includes(term)));
    if (!rows.length) { root.replaceChildren(empty('No matching customers.')); return; }
    const t = table('Customers', ['Email', 'Plan', 'Status', 'Hubs', 'Created', ''], rows.map((a) => [
      h('span', {}, a.email, a.email.toLowerCase() === me ? chip('you', 'indigo') : null),
      document.createTextNode(a.plan), chip(a.status, a.status === 'active' || a.status === 'trialing' ? 'green' : a.status === 'past_due' ? 'red' : 'grey'),
      h('span', { class: 'num' }, String(a.hubs)), document.createTextNode(fmtDate(new Date(a.created * 1000).toISOString())),
      h('a', { class: 'btn btn-sm', href: `/support/view-as?account=${encodeURIComponent(a.id)}`, 'aria-label': `View as ${a.email}` }, 'View as'),
    ]));
    t.querySelectorAll('tbody tr').forEach((tr, i) => { if (rows[i].email.toLowerCase() === me) tr.classList.add('cust-me'); });
    root.replaceChildren(t);
  };
  q.addEventListener('input', render);
  render();
}).catch((e) => failInto(root, e));
