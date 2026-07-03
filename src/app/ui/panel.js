import { initials } from '../store/model.js';
import { NODE_TYPE_LABELS } from '../viz/colors.js';

const ATTR_ROWS = [
  ['jobTitle', 'Job title'],
  ['department', 'Department'],
  ['companyName', 'Company'],
  ['officeLocation', 'Office'],
  ['city', 'City'],
  ['state', 'State'],
  ['employeeType', 'Employee type'],
  ['mail', 'Mail'],
  ['userPrincipalName', 'UPN']
];

let panelEl, contentEl, actions = {};

export function initPanel({ onFocus, onExpand, onClose, onNeedManager, onPickManager }) {
  actions = { onFocus, onExpand, onNeedManager, onPickManager };
  panelEl = document.getElementById('panel');
  contentEl = document.getElementById('panel-content');
  document.getElementById('panel-close').addEventListener('click', () => {
    hidePanel();
    onClose?.();
  });
}

export function hidePanel() {
  panelEl.hidden = true;
}

export function showPanel(node, { isFocus }) {
  contentEl.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'panel-head';

  if (node.type === 'user' && node.photoUrl) {
    const img = document.createElement('img');
    img.className = 'panel-avatar';
    img.src = node.photoUrl;
    img.alt = '';
    head.appendChild(img);
  } else {
    const av = document.createElement('div');
    av.className = 'panel-avatar initials';
    av.textContent = node.type === 'user' ? initials(node.label) : '◈';
    head.appendChild(av);
  }

  const title = document.createElement('div');
  title.className = 'panel-title';
  const h2 = document.createElement('h2');
  h2.textContent = node.label;
  if (node.type === 'user' && node.data.userType === 'Guest') {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = 'Guest';
    h2.appendChild(b);
  }
  if (node.type === 'user' && node.data.accountEnabled === false) {
    const b = document.createElement('span');
    b.className = 'badge disabled';
    b.textContent = 'Disabled';
    h2.appendChild(b);
  }
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent =
    node.type === 'user'
      ? node.data.jobTitle ?? NODE_TYPE_LABELS.user
      : NODE_TYPE_LABELS[node.type] ?? node.type;
  title.append(h2, sub);
  head.appendChild(title);
  contentEl.appendChild(head);

  const hopLine = document.createElement('div');
  hopLine.className = 'sub';
  hopLine.textContent =
    node.hop === 0
      ? 'This is the focus'
      : node.hop === Infinity
        ? 'Not connected to focus'
        : `${node.hop} hop${node.hop > 1 ? 's' : ''} from focus`;
  contentEl.appendChild(hopLine);

  const btns = document.createElement('div');
  btns.className = 'panel-actions';
  if (!isFocus) {
    const focusBtn = document.createElement('button');
    focusBtn.className = 'primary';
    focusBtn.textContent = 'Set as focus';
    focusBtn.addEventListener('click', () => actions.onFocus?.(node));
    btns.appendChild(focusBtn);
  }
  if (node.type !== 'servicePrincipal') {
    const expandBtn = document.createElement('button');
    expandBtn.className = 'ghost';
    expandBtn.textContent = node.expanded ? 'Re-expand' : 'Expand';
    expandBtn.addEventListener('click', () => actions.onExpand?.(node));
    btns.appendChild(expandBtn);
  }
  contentEl.appendChild(btns);

  if (node.type === 'user') {
    const dl = document.createElement('dl');
    dl.className = 'panel-attrs';

    // Manager is a Graph navigation property, resolved lazily by main.js
    // (from the store if org-expanded, otherwise one /manager call).
    if (node.managerInfo !== false) {
      const dt = document.createElement('dt');
      dt.textContent = 'Manager';
      const dd = document.createElement('dd');
      if (node.managerInfo) {
        const link = document.createElement('span');
        link.className = 'panel-link';
        link.textContent = node.managerInfo.displayName;
        link.title = 'Set as focus';
        link.addEventListener('click', () => actions.onPickManager?.(node.managerInfo));
        dd.appendChild(link);
      } else {
        dd.textContent = '…';
        actions.onNeedManager?.(node);
      }
      dl.append(dt, dd);
    }

    for (const [key, label] of ATTR_ROWS) {
      const val = node.data[key];
      if (!val) continue;
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = val;
      dl.append(dt, dd);
    }
    contentEl.appendChild(dl);
  } else if (node.data.description) {
    const p = document.createElement('p');
    p.className = 'sub';
    p.textContent = node.data.description;
    contentEl.appendChild(p);
  }

  panelEl.hidden = false;
}
