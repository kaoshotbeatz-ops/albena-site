import './shell';
import { api } from '../lib/api';
import { h, must, panel, chip, fmtDate, money, failInto, table, empty } from '../lib/ui';

const root = must('#root');
const tone = (s: string) => (s === 'delivered' ? 'green' : s === 'shipped' ? 'indigo' : s === 'canceled' ? 'red' : 'amber');
api.orders().then((list) => {
  root.setAttribute('aria-busy', 'false');
  if (!list.length) { root.replaceChildren(panel('Hardware orders', empty('No hardware orders yet.'))); return; }
  const p = panel('Hardware orders', table('Hardware orders', ['Order', 'Item', 'Placed', 'Total', 'Status', 'Tracking'], list.map((o) => [
    h('span', { class: 'mono' }, o.id), document.createTextNode(o.item), document.createTextNode(fmtDate(o.placedAt)),
    h('span', { class: 'num' }, o.total !== undefined ? money(o.total, o.currency) : ''), chip(o.status, tone(o.status)),
    h('span', { class: 'mono' }, o.tracking ?? ''),
  ])));
  p.querySelector('.panel-body')?.classList.add('flush');
  root.replaceChildren(p);
}).catch((e) => failInto(root, e));
