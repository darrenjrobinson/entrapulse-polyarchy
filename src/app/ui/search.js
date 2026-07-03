import { searchUsers } from '../bridge.js';

let timer = null;
let lastTerm = '';

export function initSearch(onPick) {
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');

  input.disabled = false;

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const term = input.value.trim();
    if (term.length < 2) {
      results.hidden = true;
      return;
    }
    timer = setTimeout(async () => {
      lastTerm = term;
      try {
        const users = await searchUsers(term);
        if (term !== lastTerm) return; // stale response
        renderResults(results, users, (u) => {
          results.hidden = true;
          input.value = '';
          onPick(u);
        });
      } catch {
        renderResults(results, [], () => {});
      }
    }, 300);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search-box')) results.hidden = true;
  });
}

function renderResults(el, users, onPick) {
  el.innerHTML = '';
  if (!users.length) {
    const li = document.createElement('li');
    li.className = 'r-empty';
    li.textContent = 'No matches';
    el.appendChild(li);
  }
  for (const u of users) {
    const li = document.createElement('li');
    const name = document.createElement('div');
    name.className = 'r-name';
    name.textContent = u.displayName ?? u.userPrincipalName;
    const sub = document.createElement('div');
    sub.className = 'r-sub';
    sub.textContent = [u.jobTitle, u.department].filter(Boolean).join(' · ') || u.userPrincipalName;
    li.append(name, sub);
    li.addEventListener('click', () => onPick(u));
    el.appendChild(li);
  }
  el.hidden = false;
}
