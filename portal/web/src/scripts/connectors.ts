import './shell';
import { api } from '../lib/api';
import { h, must, panel, chip, dot, failInto, empty } from '../lib/ui';

const root = must('#root');
api.account().then((a) => {
  root.setAttribute('aria-busy', 'false');
  const list = a.connectors ?? [];
  const ul = list.length ? h('ul', { class: 'list' }, ...list.map((c) => h('li', {},
    h('span', { class: 'name' }, dot(c.status === 'connected' ? 'ok' : 'warn'), c.name),
    chip(c.status === 'connected' ? 'Connected' : 'Needs attention on Hub', c.status === 'connected' ? 'green' : 'amber')))) : null;
  const p = panel('Connected services', ul ? h('div', {}, ul) : empty('No connectors reported yet.'));
  if (ul) p.querySelector('.panel-body')?.classList.add('flush');
  root.replaceChildren(h('div', { class: 'stack' },
    h('p', { class: 'note' }, 'Connectors are managed on your Hub. Credentials and tokens stay on the Hub and never pass through this portal; this list only shows connection status.'), p));
}).catch((e) => failInto(root, e));
