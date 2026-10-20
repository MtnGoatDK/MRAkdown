// Imported on demand the first time the user switches to edit, split or live mode, then kept for the session.
import { createToolbar } from '/__app/format.js';

/**
 * @param {{ view: HTMLElement, showNote: (note: object) => void,
 *           setDirty: (dirty: boolean) => void, getMode: () => string, isPlain: () => boolean,
 *           saveDraft: (text: string) => Promise<{ root: string, path: string } | null>,
 *           write: (file: { root: string, path: string }, edits: { text: string, saved: string, crlf: boolean }) => Promise<boolean>,
 *           openLink: (href: string, e: MouseEvent) => void,
 *           calloutColor: (type: string) => string }} host
 *   saveDraft asks where to save a new note and writes it; resolves to the saved note, or null if cancelled.
 *   write saves a file's text (see writeFile in app.js); resolves false if it wasn't saved.
 *   shortcut(keydown event) names the editor action its keys are set to ('bold', 'italic', 'link') or null, and
 *   hint(action) gives its keys for tooltips (see "Keyboard shortcuts" in app.js).
 *   isPlain says whether the file isn't Markdown, and viewKind how the reading view shows it ('json', 'xml', 'csv',
 *   'text' or 'code'): Live mode is a code editor for JSON and XML, a table for CSV, and plain text otherwise.
 *   openLink opens a link clicked in Live mode; calloutColor gives a callout type's colour (see app.js).
 */
export function createEditor({ view, showNote, setDirty, getMode, isPlain, viewKind, saveDraft, write, shortcut, hint, openLink, calloutColor }) {
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/__app/editor.css';
  document.head.append(css);

  const pane = document.createElement('div');
  pane.className = 'editor-pane';
  const ta = document.createElement('textarea');
  ta.className = 'editor';
  ta.spellcheck = false;
  ta.disabled = true;
  ta.placeholder = 'Open a file to edit it';

  /* ---------- Surfaces: the plain text box, or the Live editor (live.js) ---------- */

  // Both offer the same operations, so the toolbar, loading and saving don't care which one is in use.
  const textSurface = {
    element: ta,
    get value() { return ta.value; },
    set value(text) { ta.value = text; },
    get selectionStart() { return ta.selectionStart; },
    get selectionEnd() { return ta.selectionEnd; },
    setSelectionRange: (start, end) => ta.setSelectionRange(start, end),
    /** Replaces the selection, keeping it in the undo history. */
    replaceSelection(text) {
      if (text) document.execCommand('insertText', false, text);
      else if (ta.selectionStart !== ta.selectionEnd) document.execCommand('delete');
    },
    undo: () => document.execCommand('undo'),
    redo: () => document.execCommand('redo'),
    focus: () => ta.focus(),
    get disabled() { return ta.disabled; },
    set disabled(value) { ta.disabled = value; },
    get scrollTop() { return ta.scrollTop; },
    set scrollTop(value) { ta.scrollTop = value; },
    on: (type, fn) => ta.addEventListener(type, fn),
    scrollBox: () => ta,
  };
  // Live mode's surfaces, each created the first time it's needed: markdown (live.js), code for JSON and XML
  // (live-code.js) and csv (live-csv.js).
  const liveSurfaces = {};
  let surface = textSurface;
  const listeners = []; // [type, fn] from the toolbar, added to each surface

  /** What the toolbar works on: always the surface in use. */
  const current = {
    get element() { return surface.element; },
    get value() { return surface.value; },
    get selectionStart() { return surface.selectionStart; },
    get selectionEnd() { return surface.selectionEnd; },
    setSelectionRange: (start, end) => surface.setSelectionRange(start, end),
    replaceSelection: (text) => surface.replaceSelection(text),
    undo: () => surface.undo(),
    redo: () => surface.redo(),
    focus: () => surface.focus(),
    get disabled() { return surface.disabled; },
    on(type, fn) {
      listeners.push([type, fn]);
      textSurface.on(type, fn);
      for (const s of Object.values(liveSurfaces)) s.on(type, fn);
    },
    isPlainFile: () => isPlain(),
  };

  pane.append(createToolbar(current, { uploadImage, shortcut, hint }), ta);
  view.before(pane);
  setupSplitResizer(pane);

  /** Which surface the file needs: Live mode depends on the file type; the other modes use the text box. */
  function wantedSurface() {
    if (getMode() !== 'live') return 'text';
    if (!isPlain()) return 'markdown';
    const kind = viewKind();
    return kind === 'json' || kind === 'xml' ? 'code' : kind === 'csv' ? 'csv' : 'text';
  }

  async function createSurface(name) {
    if (name === 'markdown') {
      const { createLiveSurface } = await import('/__app/live.js');
      return createLiveSurface(pane, { onInput, calloutColor, fileUrl, resolveWikilink, openLink: openLiveLink });
    }
    const title = () => (note?.path ?? '').split('/').pop();
    if (name === 'code') {
      const { createCodeSurface } = await import('/__app/live-code.js');
      return createCodeSurface(pane, { onInput, title });
    }
    const { createCsvSurface } = await import('/__app/live-csv.js');
    return createCsvSurface(pane, { onInput, title });
  }

  /**
   * Uses the surface the pane's mode and file need (see wantedSurface). The text, selection and the place you're at
   * move across, so switching between Edit and Live keeps unsaved edits.
   */
  async function useSurface() {
    const name = wantedSurface();
    if (name !== 'text' && !liveSurfaces[name]) {
      const created = await createSurface(name);
      created.root.classList.add('live-surface');
      for (const [type, fn] of listeners) created.on(type, fn);
      liveSurfaces[name] = created;
    }
    const next = name === 'text' ? textSurface : liveSurfaces[name];
    // The code editor's language follows the file (set before its text is)
    next.setLanguage?.(viewKind());
    if (next === surface) return;
    const { value, selectionStart, selectionEnd, disabled } = surface;
    const scrolled = scrollFraction(surface);
    surface = next;
    pane.classList.toggle('live-on', surface !== textSurface);
    for (const s of Object.values(liveSurfaces)) s.root.classList.toggle('surface-active', s === surface);
    surface.value = value;
    surface.disabled = disabled;
    surface.setSelectionRange(selectionStart, selectionEnd);
    requestAnimationFrame(() => setScrollFraction(surface, scrolled));
  }

  function scrollFraction(s) {
    const box = s.scrollBox();
    const max = box.scrollHeight - box.clientHeight;
    return max > 0 ? box.scrollTop / max : 0;
  }
  function setScrollFraction(s, fraction) {
    const box = s.scrollBox();
    box.scrollTop = fraction * (box.scrollHeight - box.clientHeight);
  }

  // Note being edited: { root, path }, or a new unsaved note: { root, draft: true, text }.
  let note = null;
  let saved = '';    // text as last loaded/saved, with \n line endings ('' for a new note)
  let crlf = false;  // the file uses \r\n line endings; restored on save
  let previewTimer = 0;

  // A new note has no path yet; the server renders it relative to the root folder.
  const query = (n) => `?r=${encodeURIComponent(n.root)}&n=${n.draft ? '' : encodeURIComponent(n.path)}`;

  /** URL of the note's folder (for links and images relative to it), e.g. /f/{root}/notes/. */
  function noteBase() {
    if (!note) return '/';
    const dir = note.draft ? '' : note.path.split('/').slice(0, -1).map(encodeURIComponent).join('/');
    return `/f/${encodeURIComponent(note.root)}/${dir ? `${dir}/` : ''}`;
  }

  /** An image or link address in the note, as a URL (relative ones are relative to the note's folder). */
  function fileUrl(url) {
    try {
      // Relative to the page's own address (on Linux the host's custom scheme has no usable origin).
      return new URL(url.replace(/^<|>$/g, ''), new URL(noteBase(), location.href)).href;
    } catch {
      return url;
    }
  }

  /** Where a [[wikilink]] or ![[embed]] points, looked up by the host like in the reading view; null if nowhere. */
  async function resolveWikilink(target) {
    if (!note) return null;
    const res = await fetch(`/__api/resolve${query(note)}&t=${encodeURIComponent(target)}`);
    return res.ok ? (await res.json()).url : null;
  }

  /** A link clicked in Live mode: a [[wikilink]] (looked up like in the reading view) or an address. */
  async function openLiveLink({ href, wiki }, e) {
    if (!note) return;
    if (wiki) {
      const [target, heading] = wiki.split('#');
      if (!target) return; // [[#Heading]] in the same note
      const url = await resolveWikilink(target);
      if (url) openLink(url + (heading ? `#${encodeURIComponent(heading)}` : ''), e);
      return;
    }
    if (href && !href.startsWith('#')) openLink(fileUrl(href), e);
  }

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
  // Checked on every keystroke: surfaces that can compare without building the whole text (big files) do so.
  const isDirty = () => note !== null && (surface.differs ? surface.differs(saved) : surface.value !== saved);
  const sameAs = (n) => note !== null && n !== null && !n.draft && !note.draft && n.root === note.root && n.path === note.path;

  /**
   * Loads a note's source ({ root, path }), a new note ({ root, draft: true, text }) or nothing (null).
   * Keeps caret and scroll when the text on disk is unchanged. edits: unsaved edits kept for the file while it wasn't
   * in the editor (from snapshot), shown instead of the text on disk.
   */
  async function load(n, edits = null) {
    // The file type decides between the text box and the Live editor; pick before filling it.
    await useSurface();
    if (n !== null && !n.draft && edits) {
      note = n;
      saved = edits.saved;
      crlf = edits.crlf;
      surface.disabled = false;
      surface.value = edits.text;
      surface.setSelectionRange(edits.selectionStart ?? 0, edits.selectionEnd ?? 0);
      surface.scrollTop = edits.scrollTop ?? 0;
      setDirty(isDirty());
      return;
    }
    if (n === null) {
      note = null;
      saved = '';
      surface.value = '';
      surface.disabled = true;
      setDirty(false);
      return;
    }
    if (n.draft) {
      note = n;
      saved = '';
      crlf = false;
      surface.disabled = false;
      surface.value = n.text ?? '';
      surface.setSelectionRange(surface.value.length, surface.value.length);
      surface.scrollTop = 0;
      setDirty(isDirty());
      return;
    }
    const res = await fetch('/__api/source' + query(n));
    if (!res.ok) return load(null);
    const raw = await res.text();
    const text = raw.replace(/\r\n/g, '\n');
    if (sameAs(n) && text === surface.value) {
      saved = text;
      setDirty(false);
      return;
    }

    const sameNote = sameAs(n);
    const { selectionStart, selectionEnd, scrollTop } = surface;
    note = n;
    saved = text;
    crlf = raw.includes('\r\n');
    surface.disabled = false;
    surface.value = text;
    if (sameNote) {
      surface.setSelectionRange(selectionStart, selectionEnd);
      surface.scrollTop = scrollTop;
    } else {
      surface.setSelectionRange(0, 0);
      surface.scrollTop = 0;
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
      const text = surface.value;
      const savedNote = await saveDraft(text);
      if (!savedNote) return false;
      note = savedNote;
      saved = text;
      setDirty(isDirty());
      return true;
    }
    if (!isDirty()) return true;
    const target = note;
    const text = surface.value;
    if (!(await write(target, { text, saved, crlf }))) return false;
    if (sameAs(target)) {
      saved = text;
      setDirty(isDirty());
    }
    return true;
  }

  /** Renders the unsaved text into the preview pane (split mode only). */
  async function renderPreview() {
    if (getMode() !== 'split' || note === null) return;
    const res = await fetch('/__api/render' + query(note), { method: 'POST', body: surface.value });
    if (!res.ok) return;
    const top = view.scrollTop;
    showNote(await res.json());
    view.scrollTop = top;
  }

  function onInput() {
    setDirty(isDirty());
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 120);
  }
  ta.addEventListener('input', onInput);

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
    divider.className = 'split-resizer';
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
    /** Switches between the text box and the Live editor for the pane's mode (see useSurface). */
    useSurface,
    /** True while the editor has unsaved edits. */
    isDirty,
    /**
     * The unsaved edits for a file ({ root, path }), to keep while the file isn't in the editor (see load), or null
     * if the editor doesn't have that file or it has no unsaved edits.
     */
    snapshot: (file) => (sameAs(file) && isDirty()
      ? { text: surface.value, saved, crlf, selectionStart: surface.selectionStart, selectionEnd: surface.selectionEnd, scrollTop: surface.scrollTop }
      : null),
    /** Picks up changes made to the file outside the editor, unless there are unsaved edits. */
    refresh: () => (isDirty() || note === null || note.draft ? Promise.resolve() : load(note)),
    focus: () => surface.focus(),
    /** The current text, e.g. to keep a new note's draft while another tab is shown. */
    text: () => surface.value,
  };
}
