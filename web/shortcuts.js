// The dialog for changing keyboard shortcuts, opened from Settings (see "Keyboard shortcuts" in app.js).
// Loaded the first time it is opened, then kept.

const css = document.createElement('link');
css.rel = 'stylesheet';
css.href = '/__app/shortcuts.css';
document.head.append(css);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Shows the shortcuts dialog. Changes take effect (and are remembered) right away.
 * @param {{ actions: { id: string, group: string, label: string, keys: string[] }[],
 *           shortcuts: Record<string, string[]>, keysOf: (e: KeyboardEvent) => string | null,
 *           describeKeys: (keys: string) => string, setShortcuts: (next: Record<string, string[]>) => void }} host
 *   actions with their default keys; shortcuts: the keys in use now; keysOf turns a key press into keys
 *   ("Ctrl+Shift+E"); setShortcuts uses and remembers new keys.
 */
export function openShortcutsDialog({ actions, shortcuts, keysOf, describeKeys, setShortcuts }) {
  let current = structuredClone(shortcuts);
  let recording = null; // id of the action waiting for keys

  const backdrop = document.createElement('div');
  backdrop.className = 'shortcuts-backdrop';
  backdrop.innerHTML = `
    <div class="shortcuts-dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div class="shortcuts-head">
        <span>Keyboard shortcuts</span>
        <button class="shortcuts-close" title="Close (Esc)" aria-label="Close">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M17 7 7 17"/><path d="m7 7 10 10"/></svg>
        </button>
      </div>
      <div class="shortcuts-note" aria-live="polite"></div>
      <div class="shortcuts-list"></div>
      <div class="shortcuts-foot"><button class="shortcuts-reset-all">Reset all to defaults</button></div>
    </div>`;
  const list = backdrop.querySelector('.shortcuts-list');
  const note = backdrop.querySelector('.shortcuts-note');
  const say = (text) => { note.textContent = text; };

  const isDefault = (a) => current[a.id].join() === a.keys.join();

  function render() {
    const scroll = list.scrollTop;
    let html = '';
    let group = null;
    for (const a of actions) {
      if (a.group !== group) {
        group = a.group;
        html += `<div class="shortcuts-group">${esc(group)}</div>`;
        // Going to a tab by number belongs with the tabs, and can't be changed.
        if (group === 'Tabs and windows') {
          html += `<div class="shortcut-row"><span class="shortcut-label">Go to tab 1–8, the last tab</span>
            <span class="shortcut-keys"><kbd>Ctrl+1…8</kbd><kbd>Ctrl+9</kbd></span><span class="shortcut-fixed">Fixed</span></div>`;
        }
      }
      const keys = current[a.id].map((k) => `<span class="shortcut-key"><kbd>${esc(describeKeys(k))}</kbd><button
        class="shortcut-remove" data-id="${a.id}" data-keys="${esc(k)}" title="Remove ${esc(describeKeys(k))}"
        aria-label="Remove ${esc(describeKeys(k))}">×</button></span>`).join('');
      const add = recording === a.id
        ? '<button class="shortcut-add recording" data-id="' + a.id + '">Press keys… (Esc cancels)</button>'
        : `<button class="shortcut-add" data-id="${a.id}">+ Add</button>`;
      html += `<div class="shortcut-row${recording === a.id ? ' recording' : ''}">
        <span class="shortcut-label">${esc(a.label)}</span>
        <span class="shortcut-keys">${keys}${add}</span>
        ${isDefault(a) ? '<span></span>' : `<button class="shortcut-reset" data-id="${a.id}">Reset</button>`}
      </div>`;
    }
    list.innerHTML = html;
    list.scrollTop = scroll;
    backdrop.querySelector('.shortcuts-reset-all').disabled = actions.every(isDefault);
  }

  function update(next, message = '') {
    current = next;
    setShortcuts(structuredClone(next));
    render();
    say(message);
  }

  /** Why these keys can't be a shortcut, or '' if they can. */
  function problem(keys) {
    if (/^Ctrl\+[1-9]$/.test(keys)) return `${keys} is kept for going to a tab.`;
    const withModifier = /^(Ctrl|Alt)\+/.test(keys);
    const functionKey = /(^|\+)F([1-9]|1[0-9]|2[0-4])$/.test(keys);
    if (!withModifier && !functionKey) {
      return `${describeKeys(keys)} on its own is needed for typing: add Ctrl or Alt, or use a function key (F1–F12).`;
    }
    return '';
  }

  /** Gives keys to an action; if another action had them, they move. */
  function assign(id, keys) {
    const next = structuredClone(current);
    const previous = actions.find((a) => a.id !== id && next[a.id].includes(keys));
    if (previous) next[previous.id] = next[previous.id].filter((k) => k !== keys);
    if (!next[id].includes(keys)) next[id].push(keys);
    update(next, previous ? `${describeKeys(keys)} moved here from “${previous.label}”.` : '');
  }

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.classList.contains('shortcut-add')) {
      recording = recording === id ? null : id;
      say('');
      render();
      list.querySelector('.shortcut-add.recording')?.focus();
    } else if (btn.classList.contains('shortcut-remove')) {
      update({ ...structuredClone(current), [id]: current[id].filter((k) => k !== btn.dataset.keys) });
    } else if (btn.classList.contains('shortcut-reset')) {
      const action = actions.find((a) => a.id === id);
      const next = structuredClone(current);
      // The default keys may be in use by another action now: they move back here.
      for (const keys of action.keys) {
        for (const other of actions) if (other.id !== id) next[other.id] = next[other.id].filter((k) => k !== keys);
      }
      next[id] = [...action.keys];
      update(next);
    }
  });
  backdrop.querySelector('.shortcuts-reset-all').onclick = () => {
    recording = null;
    update(Object.fromEntries(actions.map((a) => [a.id, [...a.keys]])), 'All shortcuts are back to their defaults.');
  };

  // While the dialog is open, keys don't reach the app's shortcuts: they're recorded, or close the dialog (Esc).
  function onKey(e) {
    e.stopPropagation();
    if (recording) {
      e.preventDefault();
      if (e.key === 'Escape') {
        recording = null;
        render();
        return;
      }
      const keys = keysOf(e);
      if (!keys) return; // a modifier on its own: wait for the rest
      const why = problem(keys);
      if (why) {
        say(why);
        return;
      }
      const id = recording;
      recording = null;
      assign(id, keys);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }
  function close() {
    removeEventListener('keydown', onKey, true);
    backdrop.remove();
  }
  addEventListener('keydown', onKey, true);
  backdrop.querySelector('.shortcuts-close').onclick = close;
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(); });

  render();
  document.body.append(backdrop);
  backdrop.querySelector('.shortcuts-close').focus();
}
