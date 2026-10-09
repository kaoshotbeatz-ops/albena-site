import './shell';
import { api } from '../lib/api';
import { h, must, panel, chip, failInto } from '../lib/ui';
import type { Account } from '../lib/types';

const root = must('#root');
let acct: Account;

function render(canInvite: boolean) {
  const ul = h('ul', { class: 'list' }, ...acct.members.map((m) => h('li', {},
    h('div', { class: 'main' }, h('span', { class: 'name' }, m.email)), h('div', { class: 'row' }, chip(m.role, m.role === 'owner' ? 'indigo' : 'grey'), ))));
  const panels = [panel('Members', h('div', {}, ul))];
  panels[0].querySelector('.panel-body')?.classList.add('flush');
  panels.push(panel('Invite a member', h('p', { class: 'mut' }, canInvite ? 'Invitations are not available yet. For now each person signs in with their own email and has their own account.' : 'Only the account owner can invite people.')));
  root.replaceChildren(h('div', { class: 'grid-2' }, ...panels));
  root.setAttribute('aria-busy', 'false');
}
Promise.all([api.account(), api.me()]).then(([a, me]) => { acct = a; render(me.role === 'owner'); }).catch((e) => failInto(root, e));
