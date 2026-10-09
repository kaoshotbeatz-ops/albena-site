import './shell';
import { startRegistration } from '@simplewebauthn/browser';
import { api, MOCK } from '../lib/api';
import { h, must, panel, chip, ago, fmtDateTime, failInto, run, toast, confirmDialog, empty, table } from '../lib/ui';
import type { Passkey, Session, SignIn } from '../lib/types';

const root = must('#root');
let passkeys: Passkey[] = [];
let sessions: Session[] = [];
let history: SignIn[] = [];

function passkeyPanel() {
  const add = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Add a passkey');
  add.addEventListener('click', async () => {
    const ok = await run(add, async () => {
      if (MOCK) { passkeys = [...passkeys, { id: `pk${Date.now()}`, name: 'This device', createdAt: new Date().toISOString(), lastUsedAt: null }]; return true; }
      const opts = await api.passkeyRegisterOptions();
      const optionsJSON = (opts.options ?? opts) as Parameters<typeof startRegistration>[0]['optionsJSON'];
      let response;
      try { response = await startRegistration({ optionsJSON }); }
      catch (e) { if (e instanceof Error && e.name === 'NotAllowedError') return false; throw e; }
      await api.passkeyRegisterVerify({ response, challengeId: (opts as { challengeId?: string }).challengeId });
      passkeys = (await api.me()).passkeys ?? passkeys;
      return true;
    }, undefined);
    if (ok) { toast('Passkey added'); render(); }
  });
  const body = passkeys.length ? h('ul', { class: 'list' }, ...passkeys.map((k) => {
    const rm = h('button', { class: 'btn btn-danger btn-sm', type: 'button', 'aria-label': `Remove passkey ${k.name}` }, 'Remove');
    rm.addEventListener('click', async () => {
      if (passkeys.length === 1 && !await confirmDialog('Remove your only passkey?', 'You will still be able to sign in with an email link.', 'Remove', { danger: true })) return;
      else if (passkeys.length > 1 && !await confirmDialog(`Remove ${k.name}?`, 'This device will no longer be able to sign in with it.', 'Remove', { danger: true })) return;
      if (await run(rm, () => api.passkeyRemove(k.id), 'Passkey removed') !== undefined) { passkeys = passkeys.filter((x) => x.id !== k.id); render(); }
    });
    return h('li', {}, h('div', { class: 'main' }, h('span', { class: 'name' }, k.name), h('span', { class: 'sub' }, `Added ${fmtDateTime(k.createdAt)} · last used ${ago(k.lastUsedAt)}`)), rm);
  })) : empty('No passkeys yet. Passkeys let you sign in with Touch ID, Face ID or a security key; nothing to type or remember.');
  const p = panel('Passkeys', h('div', {}, body), add);
  if (passkeys.length) p.querySelector('.panel-body')?.classList.add('flush');
  return p;
}
function sessionsPanel() {
  const ul = h('ul', { class: 'list' }, ...sessions.map((s) => {
    const kids: Node[] = [h('div', { class: 'main' }, h('span', { class: 'name' }, s.device, s.current && chip('This device', 'indigo')),
      h('span', { class: 'sub' }, `${s.ip ? `${s.ip} · ` : ''}signed in ${fmtDateTime(s.createdAt)} · active ${ago(s.lastSeenAt)}`))];
    if (!s.current) {
      const b = h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': `Revoke session on ${s.device}` }, 'Revoke');
      b.addEventListener('click', async () => { if (await run(b, () => api.revokeSession(s.id), 'Session revoked') !== undefined) { sessions = sessions.filter((x) => x.id !== s.id); render(); } });
      kids.push(b);
    }
    return h('li', {}, ...kids);
  }));
  const p = panel('Active sessions', h('div', {}, ul));
  p.querySelector('.panel-body')?.classList.add('flush');
  return p;
}
function historyPanel() {
  if (!history.length) return panel('Sign-in history', empty('No sign-in history to show.'));
  const p = panel('Sign-in history', table('Sign-in history', ['When', 'Method', 'Device', 'Result'], history.map((x) => [
    document.createTextNode(fmtDateTime(x.at)), document.createTextNode(x.method === 'passkey' ? 'Passkey' : 'Email link'), document.createTextNode(x.device), chip(x.ok ? 'Success' : 'Failed', x.ok ? 'green' : 'red')])));
  p.querySelector('.panel-body')?.classList.add('flush');
  return p;
}
function render() { root.replaceChildren(h('div', { class: 'stack' }, passkeyPanel(), sessionsPanel(), historyPanel())); root.setAttribute('aria-busy', 'false'); }

Promise.all([api.me(), api.sessions(), api.history()]).then(([me, s, hi]) => { passkeys = me.passkeys ?? []; sessions = s; history = hi; render(); }).catch((e) => failInto(root, e));
