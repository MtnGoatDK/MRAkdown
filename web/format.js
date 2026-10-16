// Formatting toolbar for the Markdown editor. Loaded together with editor.js (only when editing).
// All changes go through execCommand('insertText'), so Ctrl+Z / Ctrl+Y undo and redo them.

const icon = (paths) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const ICONS = {
  undo: icon('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: icon('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  clear: icon('<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l9.6-9.6a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>'),
  bold: icon('<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>'),
  italic: icon('<path d="M19 4h-9"/><path d="M14 20H5"/><path d="M15 4 9 20"/>'),
  strike: icon('<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><path d="M4 12h16"/>'),
  code: icon('<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>'),
  link: icon('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  image: icon('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>'),
  imageFile: icon('<path d="M16 5h6"/><path d="M19 2v6"/><path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/><circle cx="9" cy="9" r="2"/>'),
  bullet: icon('<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>'),
  numbered: icon('<path d="M10 6h11"/><path d="M10 12h11"/><path d="M10 18h11"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>'),
  task: icon('<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>'),
  quote: icon('<path d="M17 6H3"/><path d="M21 12H8"/><path d="M21 18H8"/><path d="M3 12v6"/>'),
  table: icon('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M12 3v18"/>'),
  codeBlock: icon('<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>'),
};

// Line-start markers that headings, lists and quotes replace each other with (indentation is kept).
const LINE_PREFIX = /^(\s*)(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)?/;

const LINE_KINDS = {
  h2: { make: () => '## ', test: /^##\s/ },
  h3: { make: () => '### ', test: /^###\s/ },
  bullet: { make: () => '- ', test: /^[-*+]\s+(?!\[[ xX]\])/ },
  numbered: { make: (i) => `${i + 1}. `, test: /^\d+[.)]\s/ },
  task: { make: () => '- [ ] ', test: /^[-*+]\s+\[[ xX]\]\s/ },
  quote: { make: () => '> ', test: /^>/ },
};

const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|svg\+xml|bmp|avif)$/;

/**
 * Builds the toolbar for a textarea.
 * @param {HTMLTextAreaElement} ta
 * @param {{ uploadImage: (file: File, name: string) => Promise<string|null> }} host
 *   uploadImage saves an image next to the note and resolves to its relative link (or null on failure).
 */
export function createToolbar(ta, { uploadImage }) {
  /** Replaces the selection, keeping it in the undo history. */
  function replaceSelection(text) {
    if (text) document.execCommand('insertText', false, text);
    else if (ta.selectionStart !== ta.selectionEnd) document.execCommand('delete');
  }

  /** Wraps the selection in markers, or removes them if it is already wrapped. */
  function wrap(before, after, placeholder) {
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const inner = value.slice(s, e);
    const outsideBefore = value.slice(s - before.length, s);
    const outsideAfter = value.slice(e, e + after.length);
    // "*" next to "**" is bold, not italic
    const partOfLonger = before.length === 1 && value[s - 2] === before && value[s - 3] !== before;

    if (outsideBefore === before && outsideAfter === after && !partOfLonger) {
      ta.setSelectionRange(s - before.length, e + after.length);
      replaceSelection(inner);
      ta.setSelectionRange(s - before.length, e - before.length);
    } else if (inner.length > before.length + after.length && inner.startsWith(before) && inner.endsWith(after)) {
      const unwrapped = inner.slice(before.length, inner.length - after.length);
      replaceSelection(unwrapped);
      ta.setSelectionRange(s, s + unwrapped.length);
    } else {
      const text = inner || placeholder;
      replaceSelection(before + text + after);
      ta.setSelectionRange(s + before.length, s + before.length + text.length);
    }
  }

  /** The full lines touched by the selection: [start, end) offsets. */
  function selectedLines() {
    const { value } = ta;
    let e = ta.selectionEnd;
    if (e > ta.selectionStart && value[e - 1] === '\n') e--;
    const start = value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let end = value.indexOf('\n', e);
    if (end < 0) end = value.length;
    return [start, end];
  }

  /** Toggles a heading, list or quote marker on the selected lines. */
  function formatLines(kind) {
    const [start, end] = selectedLines();
    const lines = ta.value.slice(start, end).split('\n');
    const parsed = lines.map((line) => {
      const m = line.match(LINE_PREFIX);
      return { indent: m[1], prefix: m[2] ?? '', rest: line.slice(m[0].length) };
    });
    const content = parsed.filter((p) => p.rest.trim() || p.prefix);
    const turnOff = content.length > 0 && content.every((p) => kind.test.test(p.prefix));

    let n = 0;
    const result = parsed.map((p) => {
      // In a multi-line selection, leave blank lines alone.
      if (lines.length > 1 && !p.rest.trim() && !p.prefix) return p.indent + p.rest;
      return p.indent + (turnOff ? '' : kind.make(n++)) + p.rest;
    }).join('\n');

    ta.setSelectionRange(start, end);
    replaceSelection(result);
    if (lines.length > 1) ta.setSelectionRange(start, start + result.length);
  }

  /**
   * Inserts a block (table, code block) with a blank line before and after it, so following text
   * doesn't become part of it. selectFrom/selectTo pick text inside it.
   */
  function insertBlock(text, selectFrom = text.length, selectTo = selectFrom) {
    const s = ta.selectionStart;
    const before = ta.value.slice(0, s);
    const after = ta.value.slice(ta.selectionEnd);
    const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const trail = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
    replaceSelection(lead + text + trail);
    ta.setSelectionRange(s + lead.length + selectFrom, s + lead.length + selectTo);
  }

  function link(prefix = '') {
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const sel = value.slice(s, e);
    if (/^(https?:\/\/|mailto:)\S+$/.test(sel)) {
      // Selected a URL: wrap it and put the caret in the label.
      replaceSelection(`${prefix}[](${sel})`);
      ta.setSelectionRange(s + prefix.length + 1, s + prefix.length + 1);
    } else {
      const label = sel || (prefix ? 'alt text' : 'link text');
      replaceSelection(`${prefix}[${label}](url)`);
      const urlAt = s + prefix.length + label.length + 3;
      ta.setSelectionRange(urlAt, urlAt + 3);
    }
  }

  function codeBlock() {
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    // Caret goes after the opening fence so a language can be typed.
    insertBlock('```\n' + sel + '\n```', 3);
  }

  function table() {
    const text = '| Column 1 | Column 2 |\n| -------- | -------- |\n|          |          |';
    insertBlock(text, 2, 10);
  }

  /** Removes inline markers and line markers from the selection (or the current line). */
  function clearFormatting() {
    if (ta.selectionStart === ta.selectionEnd) {
      const [start, end] = selectedLines();
      ta.setSelectionRange(start, end);
    }
    const s = ta.selectionStart;
    const cleaned = ta.value.slice(s, ta.selectionEnd)
      .split('\n')
      .map((line) => {
        const m = line.match(LINE_PREFIX);
        return m[1] + line.slice(m[0].length);
      })
      .join('\n')
      .replace(/\*\*|__|~~|==|`/g, '')
      .replace(/(^|[^\w*])[*_](?=\S)(.+?)(?<=\S)[*_](?=$|[^\w*])/g, '$1$2');
    replaceSelection(cleaned);
    ta.setSelectionRange(s, s + cleaned.length);
  }

  async function insertImages(files, nameFor = (f) => f.name) {
    const images = [...files].filter((f) => IMAGE_TYPES.test(f.type));
    for (const file of images) {
      const linkPath = await uploadImage(file, nameFor(file));
      if (!linkPath) continue;
      ta.focus();
      const alt = nameFor(file).replace(/\.[^.]+$/, '');
      replaceSelection(`![${alt}](${linkPath})`);
    }
    return images.length > 0;
  }

  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.multiple = true;
  picker.hidden = true;
  picker.addEventListener('change', () => {
    insertImages(picker.files);
    picker.value = '';
  });

  const ITEMS = [
    ['undo', 'Undo (Ctrl+Z)', () => document.execCommand('undo')],
    ['redo', 'Redo (Ctrl+Y)', () => document.execCommand('redo')],
    ['clear', 'Clear formatting', clearFormatting],
    null,
    ['bold', 'Bold (Ctrl+B)', () => wrap('**', '**', 'bold text')],
    ['italic', 'Italic (Ctrl+I)', () => wrap('*', '*', 'italic text')],
    ['strike', 'Strikethrough', () => wrap('~~', '~~', 'text')],
    ['code', 'Inline code', () => wrap('`', '`', 'code')],
    ['link', 'Link (Ctrl+K)', () => link()],
    ['image', 'Image link', () => link('!')],
    ['imageFile', 'Insert image from file (or paste / drop one)', () => picker.click()],
    null,
    ['H2', 'Heading 2', () => formatLines(LINE_KINDS.h2)],
    ['H3', 'Heading 3', () => formatLines(LINE_KINDS.h3)],
    null,
    ['bullet', 'Bulleted list', () => formatLines(LINE_KINDS.bullet)],
    ['numbered', 'Numbered list', () => formatLines(LINE_KINDS.numbered)],
    ['task', 'Task list', () => formatLines(LINE_KINDS.task)],
    ['quote', 'Quote', () => formatLines(LINE_KINDS.quote)],
    ['table', 'Table', table],
    ['codeBlock', 'Code block', codeBlock],
  ];

  const bar = document.createElement('div');
  bar.className = 'md-toolbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Formatting');
  for (const item of ITEMS) {
    if (!item) {
      bar.insertAdjacentHTML('beforeend', '<span class="md-sep" aria-hidden="true"></span>');
      continue;
    }
    const [name, title, action] = item;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.dataset.action = name;
    btn.innerHTML = ICONS[name] ?? `<span class="md-text">${name}</span>`;
    // Keep focus and selection in the editor while clicking.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      if (ta.disabled) return;
      ta.focus();
      action();
    });
    bar.append(btn);
  }
  bar.append(picker);

  // Markdown helpers only apply to .md files; other files are edited as plain text.
  const isPlainFile = () => document.body.classList.contains('plain-file');

  ta.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.shiftKey || isPlainFile()) return;
    const key = e.key.toLowerCase();
    const run = { b: () => wrap('**', '**', 'bold text'), i: () => wrap('*', '*', 'italic text'), k: () => link() }[key];
    if (!run) return;
    e.preventDefault();
    run();
  });

  // Paste or drop images straight into the note.
  ta.addEventListener('paste', (e) => {
    if (isPlainFile()) return;
    const files = e.clipboardData?.files;
    if (!files?.length || ![...files].some((f) => IMAGE_TYPES.test(f.type))) return;
    e.preventDefault();
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    insertImages(files, (f) => `Pasted image ${stamp}.${f.type.split('/')[1].replace('svg+xml', 'svg').replace('jpeg', 'jpg')}`);
  });
  ta.addEventListener('dragover', (e) => {
    if (!isPlainFile() && e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  ta.addEventListener('drop', (e) => {
    if (isPlainFile() || !e.dataTransfer?.files.length) return;
    e.preventDefault();
    insertImages(e.dataTransfer.files);
  });

  return bar;
}
