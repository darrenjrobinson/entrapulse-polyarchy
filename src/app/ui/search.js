import { searchUsers } from '../bridge.js';

let timer = null;
let generation = 0; // bumped on every input/pick — responses tied to older ones are stale

export function initSearch(onPick) {
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');

  input.disabled = false;

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const gen = ++generation; // even the short-term early-return invalidates in-flight requests
    const term = input.value.trim();
    if (term.length < 2) {
      results.hidden = true;
      return;
    }
    timer = setTimeout(async () => {
      try {
        const users = await searchUsers(term);
        if (gen !== generation) return; // stale response
        renderResults(results, users, (u) => {
          generation++; // a pick invalidates anything still in flight
          results.hidden = true;
          input.value = '';
          onPick(u);
        });
      } catch {
        if (gen !== generation) return; // stale failure — newer input owns the box
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
