import './shell';
import { api } from '../lib/api';
import { h, must, panel, chip, fmtDate, failInto, run, confirmDialog, empty } from '../lib/ui';
import type { Account } from '../lib/types';

const root = must('#root');
let acct: Account;
let me: { id: string; role: 'owner' | 'member' };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ERRORS: Record<string, string> = {
  already_member: 'That person is already in your household.', already_invited: 'That person already has an invitation.',
  too_many_invites: 'Too many open invitations. Cancel one first.', invalid_email: 'Enter a valid email address.', mail_failed: 'The invitation email could not be sent. Try again.',
};

async function reload() { acct = await api.account(); render(); }

function membersPanel() {
  const owner = me.role === 'owner';
  const ul = h('ul', { class: 'list' }, ...acct.members.map((m) => {
    const rm = owner && m.role !== 'owner' ? h('button', { class: 'btn btn-sm btn-danger', type: 'button', 'aria-label': `Remove ${m.email}` }, 'Remove') : null;
    rm?.addEventListener('click', async () => {
      if (!(await confirmDialog('Remove this person?', `${m.email} will lose access to your household straight away.`, 'Remove', { danger: true }))) return;
      if (await run(rm, () => api.removeMember(m.id), 'Removed.')) await reload();
    });
    return h('li', {}, h('div', { class: 'main' }, h('span', { class: 'name' }, m.email)), h('div', { class: 'row' }, chip(m.role, m.role === 'owner' ? 'indigo' : 'grey'), rm));
  }));
  const p = panel('Members', h('div', {}, ul));
  p.querySelector('.panel-body')?.classList.add('flush');
  return p;
}

function invitePanel() {
  if (me.role !== 'owner') return panel('Invite a member', h('p', { class: 'mut' }, 'Only the account owner can invite people.'));
  const input = h('input', { class: 'input', id: 'inv-email', type: 'email', autocomplete: 'off', inputmode: 'email', placeholder: 'person@example.com', required: true, 'aria-describedby': 'inv-err' });
  const err = h('p', { class: 'err', id: 'inv-err', role: 'alert' });
  const go = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Send invitation');
  const form = h('form', { class: 'stack', novalidate: true },
    h('p', { class: 'mut' }, 'They get an email. When they sign in with that address they join your household as a member.'),
    h('div', { class: 'field' }, h('label', { for: 'inv-email' }, 'Email address'), input), err, h('div', { class: 'row' }, go));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = input.value.trim();
    if (!EMAIL.test(v)) { err.textContent = ERRORS.invalid_email; input.focus(); return; }
    err.textContent = '';
    const ok = await run(go, async () => {
      try { await api.inviteMember(v); } catch (e) { err.textContent = ERRORS[(e as { code?: string }).code ?? ''] ?? ''; throw e; }
      return true;
    }, `Invitation sent to ${v}.`);
    if (ok) await reload();
  });
  const pending = acct.invites.length
    ? h('ul', { class: 'list' }, ...acct.invites.map((i) => {
      const cancel = h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': `Cancel invitation for ${i.email}` }, 'Cancel');
      cancel.addEventListener('click', async () => { if (await run(cancel, () => api.revokeMemberInvite(i.id), 'Invitation cancelled.')) await reload(); });
      return h('li', {}, h('div', { class: 'main' }, h('span', { class: 'name' }, i.email), h('span', { class: 'sub' }, `Expires ${fmtDate(i.expiresAt)}`)), h('div', { class: 'row' }, chip('invited', 'amber'), cancel));
    }))
    : empty('No open invitations.');
  return panel('Invite a member', [form, h('h3', {}, 'Open invitations'), pending]);
}

function render() {
  root.replaceChildren(h('div', { class: 'grid-2' }, membersPanel(), invitePanel()));
  root.setAttribute('aria-busy', 'false');
}
Promise.all([api.account(), api.me()]).then(([a, m]) => { acct = a; me = m; render(); }).catch((e) => failInto(root, e));
