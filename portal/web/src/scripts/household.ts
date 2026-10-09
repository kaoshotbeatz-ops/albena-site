import './shell';
import { api } from '../lib/api';
import { h, must, panel, chip, failInto, run } from '../lib/ui';
import type { Account } from '../lib/types';

const root = must('#root');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let acct: Account;

function render(canInvite: boolean) {
  const ul = h('ul', { class: 'list' }, ...acct.members.map((m) => h('li', {},
    h('div', { class: 'main' }, h('span', { class: 'name' }, m.email)), h('div', { class: 'row' }, chip(m.role, m.role === 'owner' ? 'indigo' : 'grey'), m.status === 'invited' && chip('Invited', 'amber')))));
  const email = h('input', { class: 'input', id: 'inv-email', type: 'email', autocomplete: 'off', placeholder: 'name@example.com', 'aria-describedby': 'inv-err' });
  const err = h('p', { class: 'err', id: 'inv-err' });
  const go = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Send invite');
  const form = h('form', { class: 'stack', novalidate: '' },
    h('div', { class: 'field' }, h('label', { for: 'inv-email' }, 'Email address'), email, err),
    h('p', { class: 'mut' }, 'They get an email with a sign-in link. Members can see Hubs and use Albena; only owners manage billing and security.'),
    h('div', { class: 'row' }, go));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = email.value.trim();
    if (!EMAIL.test(v)) { err.textContent = 'Enter a valid email address.'; email.setAttribute('aria-invalid', 'true'); email.focus(); return; }
    err.textContent = ''; email.removeAttribute('aria-invalid');
    if (await run(go, () => api.invite(v), `Invite sent to ${v}`) !== undefined) {
      acct.members = [...acct.members, { id: `new-${Date.now()}`, email: v, role: 'member', status: 'invited' }];
      render(canInvite);
    }
  });
  const panels = [panel('Members', h('div', {}, ul))];
  panels[0].querySelector('.panel-body')?.classList.add('flush');
  panels.push(canInvite ? panel('Invite a member', form) : panel('Invite a member', h('p', { class: 'mut' }, 'Only the account owner can invite people.')));
  root.replaceChildren(h('div', { class: 'grid-2' }, ...panels));
  root.setAttribute('aria-busy', 'false');
}
Promise.all([api.account(), api.me()]).then(([a, me]) => { acct = a; render(me.role === 'owner'); }).catch((e) => failInto(root, e));
