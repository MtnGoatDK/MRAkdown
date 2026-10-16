// Imported on demand the first time the user switches to edit or split mode, then kept for the session.
import { createToolbar } from '/__app/format.js';

/**
 * @param {{ view: HTMLElement, showNote: (note: object) => void,
 *           setDirty: (dirty: boolean) => void, getMode: () => string,
 *           saveDraft: (text: string) => Promise<{ root: string, path: string } | null> }} host
 *   saveDraft asks where to save a new note and writes it; resolves to the saved note, or null if cancelled.
 */
export function createEditor({ view, showNote, setDirty, getMode, saveDraft }) {
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/__app/editor.css';
  document.head.append(css);

  const pane = document.createElement('div');
  pane.id = 'editor-pane';
  const ta = document.createElement('textarea');
  ta.id = 'editor';
  ta.spellcheck = false;
  ta.disabled = true;
  ta.placeholder = 'Open a file to edit it';
  pane.append(createToolbar(ta, { uploadImage }), ta);
  view.before(pane);
  setupSplitResizer(pane);

  // Note being edited: { root, path }, or a new unsaved note: { root, draft: true, text }.
  let note = null;
  let saved = '';    // text as last loaded/saved, with \n line endings ('' for a new note)
  let crlf = false;  // the file uses \r\n line endings; restored on save
  let previewTimer = 0;

  // A new note has no path yet; the server renders it relative to the root folder.
  const query = (n) => `?r=${encodeURIComponent(n.root)}&n=${n.draft ? '' : encodeURIComponent(n.path)}`;

  /** Saves an image into an "attachments" folder next to the note; resolves to its relative link. */
  async function uploadImage(file, name) {
    if (note === null) return null;
    if (note.draft) {
      alert('Save the file first (Ctrl+S), so the image can be stored next to it.');
      return null;
    }
    const res = await fetch(`/__api/upload${query(note)}&name=${encodeURIComponent(name)}`, { method: 'POST', body: file });
    if (!res.ok) {
      alert(`Could not insert ${name}:\n${await res.text()}`);
      return null;
    }
    return (await res.json()).link;
  }
  const isDirty = () => note !== null && ta.value !== saved;
  const sameAs = (n) => note !== null && n !== null && !n.draft && !note.draft && n.root === note.root && n.path === note.path;

  /**
   * Loads a note's source ({ root, path }), a new note ({ root, draft: true, text }) or nothing (null).
   * Keeps caret and scroll when the text on disk is unchanged.
   */
  async function load(n) {
    if (n === null) {
      note = null;
      saved = ta.value = '';
      ta.disabled = true;
      setDirty(false);
      return;
    }
    if (n.draft) {
      note = n;
      saved = '';
      crlf = false;
      ta.disabled = false;
      ta.value = n.text ?? '';
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.scrollTop = 0;
      setDirty(isDirty());
      return;
    }
    const res = await fetch('/__api/source' + query(n));
    if (!res.ok) return load(null);
    const raw = await res.text();
    const text = raw.replace(/\r\n/g, '\n');
    if (sameAs(n) && text === ta.value) {
      saved = text;
      setDirty(false);
      return;
    }

    const sameNote = sameAs(n);
    const { selectionStart, selectionEnd, scrollTop } = ta;
    note = n;
    saved = text;
    crlf = raw.includes('\r\n');
    ta.disabled = false;
    ta.value = text;
    if (sameNote) {
      ta.setSelectionRange(selectionStart, selectionEnd);
      ta.scrollTop = scrollTop;
    } else {
      ta.setSelectionRange(0, 0);
      ta.scrollTop = 0;
    }
    setDirty(false);
  }

  /**
   * Writes unsaved changes to disk. Resolves false if saving failed or was cancelled.
   * A new note is only saved when explicit (Ctrl+S, or "Save" when closing): that asks where to save it.
   * Automatic saves (switching notes or modes) leave new notes alone.
   */
  async function save({ explicit = false } = {}) {
    if (note?.draft) {
      if (!explicit) return true;
      const text = ta.value;
      const savedNote = await saveDraft(text);
      if (!savedNote) return false;
      note = savedNote;
      saved = text;
      setDirty(isDirty());
      return true;
    }
    if (!isDirty()) return true;
    const target = note;
    const text = ta.value;
    const res = await fetch('/__api/save' + query(target), {
      method: 'POST',
      body: crlf ? text.replace(/\n/g, '\r\n') : text,
    });
    if (!res.ok) {
      alert(`Could not save ${target.path}:\n${await res.text()}`);
      return false;
    }
    if (sameAs(target)) {
      saved = text;
      setDirty(isDirty());
    }
    return true;
  }

  /** Renders the unsaved text into the preview pane (split mode only). */
  async function renderPreview() {
    if (getMode() !== 'split' || note === null) return;
    const res = await fetch('/__api/render' + query(note), { method: 'POST', body: ta.value });
    if (!res.ok) return;
    const top = view.scrollTop;
    showNote(await res.json());
    view.scrollTop = top;
  }

  ta.addEventListener('input', () => {
    setDirty(isDirty());
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 120);
  });

  ta.addEventListener('keydown', (e) => {
    // Tab inserts a tab instead of moving focus; execCommand keeps it in the undo history.
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (!e.shiftKey) document.execCommand('insertText', false, '\t');
    }
  });

  // Keep the preview roughly in step with the editor in split mode.
  ta.addEventListener('scroll', () => {
    if (getMode() !== 'split') return;
    const max = ta.scrollHeight - ta.clientHeight;
    view.scrollTop = max > 0 ? (ta.scrollTop / max) * (view.scrollHeight - view.clientHeight) : 0;
  });

  function setupSplitResizer(pane) {
    const main = pane.parentElement;
    const divider = document.createElement('div');
    divider.id = 'split-resizer';
    divider.title = 'Drag to resize, double-click to reset';
    pane.after(divider);

    const setSplit = (fraction) => main.style.setProperty('--split', `${fraction * 100}%`);
    let fraction = 0.5;
    try { fraction = Number(localStorage.getItem('splitFraction')) || 0.5; } catch { /* storage unavailable */ }
    setSplit(fraction);

    const remember = () => {
      try { localStorage.setItem('splitFraction', String(fraction)); } catch { /* storage unavailable */ }
    };

    divider.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      divider.setPointerCapture(e.pointerId);
      divider.classList.add('dragging');
      const box = main.getBoundingClientRect();
      const move = (ev) => {
        fraction = Math.min(0.85, Math.max(0.15, (ev.clientX - box.left) / box.width));
        setSplit(fraction);
      };
      divider.addEventListener('pointermove', move);
      divider.addEventListener('pointerup', () => {
        divider.removeEventListener('pointermove', move);
        divider.classList.remove('dragging');
        remember();
      }, { once: true });
    });

    divider.addEventListener('dblclick', () => {
      fraction = 0.5;
      setSplit(fraction);
      remember();
    });
  }

  return {
    load,
    save,
    renderPreview,
    /** Picks up changes made to the file outside the editor, unless there are unsaved edits. */
    refresh: () => (isDirty() || note === null || note.draft ? Promise.resolve() : load(note)),
    focus: () => ta.focus(),
    /** The current text, e.g. to keep a new note's draft while another tab is shown. */
    text: () => ta.value,
  };
}
