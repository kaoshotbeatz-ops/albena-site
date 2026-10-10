// Build gate: fails if banned or contradictory wording reaches a PUBLIC page in web/dist.
// Admin pages (dist/admin) are internal and exempt. Usage: node scripts/public-copy-check.mjs (after `astro build`).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;
const BANNED = [
  [/approves every (action|change)/i, 'approves every action/change'],
  [/you approve every (action|change)/i, 'you approve every action/change'],
  [/(never|without)\s+(acts?|makes? a change)?\s*without your approval/i, 'unconditional approval claim'],
  [/\bbypass/i, 'bypass'],
  [/backup schedule/i, 'backup schedule'],
  [/\bforks?\b/i, 'fork'],
  [/what changed today/i, 'What changed today'],
  [/lastBackupOk/i, 'backup status payload'],
  [/\/api\/status/i, 'public status endpoint'],
];
const POLICY = 'Albena asks before anything that matters: reads run freely, low-risk actions like lights follow your rules, and messages, purchases, locks or anything risky need your approval, with a PIN for the highest-risk ones.';
const MUST_HAVE_POLICY = ['index.html', 'how-it-works.html', 'compare.html', 'faq.html'];
const MUST_NOT_EXIST = ['changelog.html'];

const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  if (statSync(p).isDirectory()) return n === '_astro' || n === 'admin' ? [] : walk(p);
  return /\.(html|txt|xml|json)$/.test(n) ? [p] : [];
});
const decode = (s) => s.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#39;|&#x27;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');

const errors = [];
for (const file of walk(DIST)) {
  const rel = relative(DIST, file);
  const raw = readFileSync(file, 'utf8');
  const text = rel.endsWith('.html') ? decode(raw) : raw;
  for (const [re, name] of BANNED) if (re.test(text)) errors.push(`${rel}: banned phrase "${name}"`);
  if (MUST_HAVE_POLICY.includes(rel) && !text.includes(POLICY)) errors.push(`${rel}: canonical approval sentence missing or altered`);
  if (/href=["']\/changelog/i.test(raw)) errors.push(`${rel}: public link to /changelog`);
}
for (const f of MUST_NOT_EXIST) if (existsSync(join(DIST, f))) errors.push(`${f}: must not be published (internal only, /admin/changelog)`);
if (!existsSync(join(DIST, 'admin', 'changelog.html'))) errors.push('admin/changelog.html missing (changelog must live behind /admin)');
const trust = readFileSync(join(DIST, existsSync(join(DIST, 'trust.html')) ? 'trust.html' : 'trust/index.html'), 'utf8');
for (const must of ['Aligned', 'In progress', 'Audit not yet completed']) if (!trust.includes(must)) errors.push(`trust page: status "${must}" missing`);
if (!/<b[^>]*>\d+<\/b>\s*listed/.test(trust)) errors.push('trust page: control count missing');

if (errors.length) { console.error('public-copy-check FAILED:\n  ' + errors.join('\n  ')); process.exit(1); }
console.log('public-copy-check OK');
