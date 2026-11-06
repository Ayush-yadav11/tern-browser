'use strict';

const list = document.getElementById('list');
const MARK = { search: '⌕', go: '→', bookmark: '★', history: '↺' };
const THEME_VARS = ['--raised', '--line', '--hover', '--text', '--muted', '--accent', '--on-accent', '--radius'];

window.ternSuggest.onShow(({ items, selected, theme }) => {
  for (const name of THEME_VARS) {
    if (theme?.[name]) document.body.style.setProperty(name, theme[name]);
  }
  list.textContent = '';
  items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = `row${index === selected ? ' on' : ''}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(index === selected));
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = MARK[item.kind] ?? '';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = item.label;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = item.sub;
    row.append(kind, title, sub);
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      window.ternSuggest.pick(index);
    });
    list.append(row);
  });
});
