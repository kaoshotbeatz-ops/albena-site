import { api, type Integrity } from './api';
import { ago, fmt, h, handleError, must } from './ui';

const refresh = must<HTMLButtonElement>('#refresh');

const row = (k: string, v: Node | string) => [h('dt', {}, k), h('dd', {}, v)];
const state = (ok: boolean, yes: string, no: string) => h('span', {}, h('span', { class: `dot ${ok ? 'ok' : 'bad'}`, 'aria-hidden': 'true' }), ' ', ok ? yes : no);

async function load() {
  refresh.setAttribute('disabled', '');
  try {
    const i = await api<Integrity>('/api/admin/integrity');
    const c = i.chain;
    must('#chain-kv').replaceChildren(
      ...row('Status', state(c.ok, 'Intact', `Broken (${c.reason ?? 'mismatch'} at #${c.brokenAtId ?? '?'})`)),
      ...row('Entries', c.rows.toLocaleString()), ...row('Sealed', c.sealed.toLocaleString()),
      ...row('Awaiting seal', String(c.unsealed)),
      ...row('Head hash', h('span', { class: 'mono' }, c.headHash ?? 'none')));
    must('#backup-kv').replaceChildren(
      ...row('Status', state(i.lastBackupOk, 'Healthy (fresh within 36 h)', 'Attention: backup missing, failed or stale')),
      ...row('Last backup', i.lastBackupAt ? `${fmt(i.lastBackupAt)} (${ago(i.lastBackupAt)})` : 'Never'),
      ...row('Last verified', i.lastVerifiedAt ? `${fmt(i.lastVerifiedAt)} (${ago(i.lastVerifiedAt)})` : 'Never'),
      ...row('Schedule', 'Daily export to R2, verified weekly (Sunday UTC)'),
      ...row('Retention', '35 daily backups; resolved or closed tickets anonymized after 365 days'));
  } catch (e) {
    handleError(e);
    for (const id of ['#chain-kv', '#backup-kv']) must(id).replaceChildren(...row('Status', 'Could not load.'));
  } finally { refresh.removeAttribute('disabled'); }
}
const runBtn = must<HTMLButtonElement>('#run-backup');
const msg = must('#sys-msg');
async function act(btn: HTMLButtonElement, path: string, ok: (r: any) => string) {
  btn.setAttribute('disabled', '');
  msg.textContent = 'Working…';
  try {
    msg.textContent = ok(await api<unknown>(path, { method: 'POST' }));
  } catch (e) { msg.textContent = 'Failed.'; handleError(e); }
  finally { btn.removeAttribute('disabled'); await load(); }
}
refresh.addEventListener('click', () => void act(refresh, '/api/admin/backup/verify', (r) => (r.ok ? 'Verified: backup and audit chain are intact.' : `Verification problems: ${r.problems.join(', ')}`)));
runBtn.addEventListener('click', () => void act(runBtn, '/api/admin/backup/run', (r) => `Backup written for ${r.date}.`));
void load();
