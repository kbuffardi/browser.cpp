'use strict';

export const SPACING_OPTIONS = Object.freeze({
  'spaces-2': Object.freeze({ id: 'spaces-2', label: '2 spaces ..', tabSize: 2, insertSpaces: true }),
  'spaces-4': Object.freeze({ id: 'spaces-4', label: '4 spaces ....', tabSize: 4, insertSpaces: true }),
  tabs: Object.freeze({ id: 'tabs', label: 'Tab ⇥', tabSize: 4, insertSpaces: false }),
});

export function normalizeSpacing(value, fallback = 'spaces-2') {
  return SPACING_OPTIONS[value] ? value : fallback;
}

export function isMakefilePath(path) {
  const name = String(path || '').split('/').pop() || '';
  return name === 'Makefile' || /\.makefile$/i.test(name);
}

export function spacingForPath(path, settings) {
  return isMakefilePath(path)
    ? normalizeSpacing(settings.makefileSpacing, 'tabs')
    : normalizeSpacing(settings.defaultSpacing, 'spaces-2');
}

export function detectSpacing(text) {
  const prefixes = String(text).match(/^[\t ]+(?=\S)/gm) || [];
  if (prefixes.some((prefix) => prefix.includes('\t'))) return 'tabs';
  const widths = prefixes.map((prefix) => prefix.length).filter(Boolean);
  if (!widths.length) return 'spaces-2';
  const width = Math.min(...widths);
  return width >= 4 ? 'spaces-4' : 'spaces-2';
}

export function convertLeadingIndentation(text, fromId, toId) {
  const from = SPACING_OPTIONS[normalizeSpacing(fromId)];
  const to = SPACING_OPTIONS[normalizeSpacing(toId)];
  if (fromId === toId) return text;
  const indent = to.insertSpaces ? ' '.repeat(to.tabSize) : '\t';
  return String(text).split(/(\r?\n)/).map((line) => line.replace(/^[\t ]+/, (prefix) => {
    if (from.insertSpaces) {
      const levels = Math.floor(prefix.length / from.tabSize);
      return indent.repeat(levels) + prefix.slice(levels * from.tabSize);
    }
    const levels = (prefix.match(/\t/g) || []).length;
    return indent.repeat(levels) + prefix.replace(/\t/g, '');
  })).join('');
}

export function initSpacingControl({ document, settings, editorAPI, getActivePath, onApply }) {
  const button = document.getElementById('spacing-button');
  const menu = document.getElementById('spacing-menu');
  if (!button || !menu) return { refresh() {}, destroy() {} };
  let open = false;
  const active = () => spacingForPath(getActivePath?.(), settings.get());
  const close = (focus = false) => { open = false; menu.hidden = true; button.setAttribute('aria-expanded', 'false'); if (focus) button.focus(); };
  const refresh = () => {
    const id = active(); const option = SPACING_OPTIONS[id];
    button.textContent = `Spacing: ${option.label.replace(/ \.{2,4}$/, '')} ⌃`;
    button.setAttribute('aria-label', `Spacing: ${option.label}`);
    for (const item of menu.querySelectorAll('[role="menuitemradio"]')) item.setAttribute('aria-checked', String(item.dataset.spacing === id));
  };
  const choose = async (id) => {
    const category = isMakefilePath(getActivePath?.()) ? 'makefileSpacing' : 'defaultSpacing';
    await settings.setSpacing(category, id);
    editorAPI.setIndentation(SPACING_OPTIONS[id]); refresh(); close(true);
  };
  const click = (event) => {
    const choice = event.target.closest?.('[data-spacing]');
    if (choice) return choose(choice.dataset.spacing);
    if (event.target.closest?.('[data-apply-spacing]')) {
      const model = editorAPI.getEditor?.()?.getModel?.();
      if (model) {
        const original = editorAPI.getValue();
        const converted = convertLeadingIndentation(original, detectSpacing(original), active());
        if (converted !== original) editorAPI.setValue(converted);
      }
      onApply?.(); close(true);
    }
  };
  const toggle = () => { open = !open; menu.hidden = !open; button.setAttribute('aria-expanded', String(open)); };
  const keydown = (event) => { if (event.key === 'Escape' && open) close(true); };
  const outsideClick = (event) => {
    if (open && !button.contains(event.target) && !menu.contains(event.target)) close();
  };
  button.addEventListener('click', toggle); menu.addEventListener('click', click); document.addEventListener('keydown', keydown); document.addEventListener('click', outsideClick);
  const unsubscribe = settings.subscribe(refresh); refresh();
  return { refresh, destroy() { unsubscribe(); button.removeEventListener('click', toggle); menu.removeEventListener('click', click); document.removeEventListener('keydown', keydown); document.removeEventListener('click', outsideClick); } };
}
