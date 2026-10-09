import './shell';
import { api } from '../lib/api';
import { h, must, panel, run, confirmDialog, toast } from '../lib/ui';

const root = must('#root');
const exp = h('button', { class: 'btn', type: 'button' }, 'Export my data');
exp.addEventListener('click', async () => {
  const data = await run(exp, () => api.exportData());
  if (data === undefined) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: 'albena-account-export.json' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  toast('Export downloaded');
});
const del = h('button', { class: 'btn btn-danger', type: 'button' }, 'Delete account');
del.addEventListener('click', async () => {
  const ok = await confirmDialog('Delete your account?', 'This permanently deletes your account, Hubs pairings, household and billing link. Active subscriptions are canceled. This cannot be undone.', 'Delete account', { typed: 'DELETE', danger: true });
  if (!ok) return;
  if (await run(del, () => api.deleteAccount('DELETE')) !== undefined) location.assign('/login');
});
root.replaceChildren(h('div', { class: 'stack' },
  h('p', { class: 'note' }, 'This portal holds only your account, billing and Hub-management data. Conversations, memory, camera and home data stay on your Hub and are never uploaded here.'),
  panel('Export your data', [h('p', { class: 'mut' }, 'Download a JSON file of everything this portal holds about your account.'), h('div', { class: 'row' }, exp)]),
  panel('Delete account', [h('p', { class: 'mut' }, 'Your Hubs keep working locally after you delete your account, but will no longer receive updates.'), h('div', { class: 'row' }, del)])));
root.setAttribute('aria-busy', 'false');
