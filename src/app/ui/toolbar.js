// View tabs + the pivot-attribute picker shown in the Attributes view:
// a dropdown of common pivots, with a "Custom attribute…" entry that reveals
// a type-ahead over the full Graph attribute catalog. Committed custom
// attributes join the dropdown for the rest of the session.

import { COMMON_ATTRIBUTES, filterAttributes } from './attr-catalog.js';

const CUSTOM = '__custom__';

let currentView = 'org';
let currentAttr = 'department';
let attrPicker, attrSelect, attrBox, attrInput, attrResults;
let activeIndex = -1;
let attrChanged;

function ensureOption(attr, label = attr) {
  let opt = [...attrSelect.options].find((o) => o.value === attr);
  if (!opt) {
    opt = document.createElement('option');
    opt.value = attr;
    opt.textContent = label;
    attrSelect.insertBefore(opt, attrSelect.querySelector(`option[value="${CUSTOM}"]`));
  }
  return opt;
}

function closeCustom() {
  attrBox.hidden = true;
  attrResults.hidden = true;
  activeIndex = -1;
  attrSelect.value = currentAttr;
}

function commit(attr) {
  const value = attr.trim();
  if (!value) return;
  ensureOption(value);
  const changed = value !== currentAttr;
  currentAttr = value;
  closeCustom();
  if (changed) attrChanged(value);
}

function showMatches() {
  const matches = filterAttributes(attrInput.value.trim());
  attrResults.innerHTML = '';
  activeIndex = -1;
  for (const attr of matches) {
    const li = document.createElement('li');
    li.textContent = attr;
    li.addEventListener('click', () => commit(attr));
    attrResults.appendChild(li);
  }
  if (!matches.length) {
    const li = document.createElement('li');
    li.className = 'r-empty';
    li.textContent = 'No catalog match — Enter uses the text as-is';
    attrResults.appendChild(li);
  }
  attrResults.hidden = false;
}

export function initToolbar({ onViewChange, onAttrChange, onReset }) {
  attrChanged = onAttrChange;

  const tabs = document.querySelectorAll('#view-tabs .tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.disabled || tab.dataset.view === currentView) return;
      tabs.forEach((t) => t.classList.toggle('active', t === tab));
      currentView = tab.dataset.view;
      attrPicker.hidden = currentView !== 'attributes';
      if (attrPicker.hidden) closeCustom();
      onViewChange(currentView);
    });
  });

  attrPicker = document.getElementById('attr-picker');
  attrSelect = document.getElementById('attr-select');
  attrBox = document.getElementById('attr-box');
  attrInput = document.getElementById('attr-input');
  attrResults = document.getElementById('attr-results');

  for (const [path, label] of COMMON_ATTRIBUTES) ensureOption(path, label);
  const custom = document.createElement('option');
  custom.value = CUSTOM;
  custom.textContent = 'Custom attribute…';
  attrSelect.appendChild(custom);
  attrSelect.value = currentAttr;

  attrSelect.addEventListener('change', () => {
    if (attrSelect.value === CUSTOM) {
      attrBox.hidden = false;
      attrInput.value = '';
      showMatches();
      attrInput.focus();
    } else {
      commit(attrSelect.value);
    }
  });

  attrInput.addEventListener('input', showMatches);

  attrInput.addEventListener('keydown', (e) => {
    const items = [...attrResults.querySelectorAll('li:not(.r-empty)')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      activeIndex = (activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.classList.toggle('active', i === activeIndex));
      items[activeIndex].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(activeIndex >= 0 ? items[activeIndex].textContent : attrInput.value);
    } else if (e.key === 'Escape') {
      closeCustom();
    }
  });

  document.addEventListener('click', (e) => {
    if (!attrBox.hidden && !e.target.closest('#attr-picker')) closeCustom();
  });

  document.getElementById('reset-btn').addEventListener('click', () => onReset?.());
}

export function getView() {
  return currentView;
}

export function getPivotAttr() {
  return currentAttr;
}
