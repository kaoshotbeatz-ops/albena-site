import { must } from '../lib/ui';
let mail = '';
try { mail = sessionStorage.getItem('albena_login_email') ?? ''; } catch { /* optional */ }
if (mail) { must('#sent-to').textContent = mail; must('#sent-line').hidden = false; }
