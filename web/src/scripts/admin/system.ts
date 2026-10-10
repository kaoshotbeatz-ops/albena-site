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
    repairBtn.hidden = c.ok || c.reason !== 'prev_hash_mismatch';   // only offered for the one break the repair is allowed to fix
    const g = i.integrity;
    const held = !!g && g.status === 'broken' && g.acked_sig !== g.broken_sig;
    ackBtn.hidden = !held;
    ackBtn.dataset.sig = g?.broken_sig ?? '';
    must('#chain-kv').replaceChildren(
      ...row('Status', state(c.ok, 'Intact', `Broken (${c.reason ?? 'mismatch'} at #${c.brokenAtId ?? '?'})`)),
      ...row('Entries', c.rows.toLocaleString()), ...row('Sealed', c.sealed.toLocaleString()),
      ...row('Awaiting seal', String(c.unsealed)),
      ...row('Head hash', h('span', { class: 'mono' }, c.headHash ?? 'none')),
      ...row('Daily verifier', g?.last_run_at ? `${g.status} at ${fmt(g.last_run_at)} (${ago(g.last_run_at)})` : 'Not run yet'),
      ...row('High-risk hold', held ? state(false, '', `ON: exports blocked until acknowledged (${g!.broken_sig})`) : g?.acked_sig && g.status === 'broken' ? `Acknowledged by ${g.acked_by} ${g.acked_at ? ago(g.acked_at) : ''}` : 'Off'));
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
const repairBtn = must<HTMLButtonElement>('#repair-chain');
const ackBtn = must<HTMLButtonElement>('#ack-chain');
const msg = must('#sys-msg');
async function act(btn: HTMLButtonElement, path: string, ok: (r: any) => string) {
  btn.setAttribute('disabled', '');
  msg.textContent = 'Working…';
  try {
    msg.textContent = ok(await api<unknown>(path, { method: 'POST' }));
  } catch (e) { msg.textContent = 'Failed.'; handleError(e); }
  finally { btn.removeAttribute('disabled'); await load(); }
}
refresh.addEventListener('click', async () => {
  await act(refresh, '/api/admin/audit/verify', (r) => (r.ok ? 'Audit chain intact.' : `Audit chain BROKEN: ${r.chain.reason} at #${r.chain.brokenAtId}`));
  const chainMsg = msg.textContent ?? '';
  await act(refresh, '/api/admin/backup/verify', (r) => `${chainMsg} ${r.ok ? 'Backup verified.' : `Backup problems: ${r.problems.join(', ')}`}`);
});
runBtn.addEventListener('click', () => void act(runBtn, '/api/admin/backup/run', (r) => `Backup written for ${r.date}.`));
repairBtn.addEventListener('click', () => {
  if (!confirm('Re-link the audit log from the broken entry onward? The old hashes are kept and the repair is itself logged.')) return;
  void act(repairBtn, '/api/admin/audit/repair', (r) => `Repaired from #${r.repairedFrom} to #${r.repairedTo}; chain ${r.chain?.ok ? 'intact' : 'still broken'}.`);
});
ackBtn.addEventListener('click', async () => {
  const sig = ackBtn.dataset.sig ?? '';
  const note = prompt(`Acknowledge audit chain break ${sig}? This lifts the high-risk hold and is itself logged. Note (required):`);
  if (!note || note.trim().length < 5) return;
  ackBtn.setAttribute('disabled', '');
  try {
    await api<unknown>('/api/admin/audit/ack', { method: 'POST', body: JSON.stringify({ sig, note: note.trim() }), headers: { 'Content-Type': 'application/json' } });
    msg.textContent = 'Break acknowledged; high-risk hold lifted.';
  } catch (e) { msg.textContent = 'Failed.'; handleError(e); }
  finally { ackBtn.removeAttribute('disabled'); await load(); }
});
void load();
