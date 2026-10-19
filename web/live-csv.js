// Live mode for CSV and TSV files: edit the table directly. The file stays CSV with its own separator; rows and cells
// you don't change are written back exactly as they were, so saving doesn't reformat the file.
// Loaded by editor.js the first time a pane needs it.

const css = document.createElement('link');
css.rel = 'stylesheet';
css.href = '/__app/live.css';
document.head.append(css);

const SEPARATOR_NAMES = { ',': 'commas', ';': 'semicolons', '\t': 'tabs', '|': 'pipes' };
const PAGE_ROWS = 1000;

/** Picks the separator that occurs most often (outside quotes) in the first lines, as the CSV viewer does. */
function detectSeparator(text) {
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let quoted = false;
  let lines = 0;
  for (const ch of text.slice(0, 20000)) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch]++;
    else if (!quoted && ch === '\n' && ++lines >= 20) break;
  }
  const [best, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return count > 0 ? best : ',';
}

/**
 * Parses CSV (RFC 4180: quoted fields may hold separators, line breaks and doubled quotes), keeping each row's and
 * cell's original text so unchanged parts can be written back as they were. Lines end in \n (see editor.js).
 */
function parse(text, sep) {
  const rows = [];
  let i = 0;
  while (i < text.length) {
    const rowStart = i;
    const cells = [];
    for (;;) {
      const cellStart = i;
      let value = '';
      const quoted = text[i] === '"';
      if (quoted) {
        i++;
        while (i < text.length) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') { value += '"'; i += 2; continue; }
            i++;
            break;
          }
          value += text[i++];
        }
      }
      // Unquoted text, or anything after a closing quote (not strictly valid, but kept)
      while (i < text.length && text[i] !== sep && text[i] !== '\n') value += text[i++];
      cells.push({ value, raw: text.slice(cellStart, i), quoted });
      if (text[i] === sep) { i++; continue; }
      break;
    }
    rows.push({ cells, raw: text.slice(rowStart, i) });
    if (text[i] === '\n') i++;
  }
  return rows;
}

const newCell = () => ({ value: '', raw: '', quoted: false, changed: true });

/**
 * Creates the table editor inside parent, with the same "surface" as the other editors (see editor.js).
 * @param {{ onInput: () => void, title: () => string }} host title gives the file name (TSV files use tabs)
 */
export function createCsvSurface(parent, host) {
  const root = document.createElement('div');
  root.className = 'live-csv';
  root.innerHTML = `
    <div class="live-csv-bar">
      <span class="live-csv-info"></span>
      <span class="live-csv-actions">
        <button type="button" data-op="addRow" title="Add a row below the current one">+ Row</button>
        <button type="button" data-op="deleteRow" title="Delete the current row">− Row</button>
        <button type="button" data-op="addColumn" title="Add a column right of the current one">+ Column</button>
        <button type="button" data-op="deleteColumn" title="Delete the current column">− Column</button>
      </span>
    </div>
    <div class="live-csv-wrap"><table class="live-csv-table"><tbody></tbody></table></div>`;
  parent.append(root);
  const info = root.querySelector('.live-csv-info');
  const wrap = root.querySelector('.live-csv-wrap');
  const tbody = root.querySelector('tbody');

  let sep = ',';
  let rows = [];
  let endsWithNewline = false;
  let disabled = true;
  let current = { r: 0, c: 0 }; // the cell last edited or focused
  let shown = 0; // rows rendered so far (big files render in pages)
  const undoStack = [];
  const redoStack = [];
  let typing = false; // edits in one cell, until another cell gets focus, are one undo step

  const columns = () => Math.max(1, ...rows.map((r) => r.cells.length));

  function cellText(cell) {
    if (!cell.changed) return cell.raw;
    const v = cell.value;
    const needsQuotes = cell.quoted || v.includes(sep) || v.includes('"') || v.includes('\n') || v.includes('\r');
    return needsQuotes ? `"${v.replace(/"/g, '""')}"` : v;
  }
  const rowText = (row) => (row.changed ? row.cells.map(cellText).join(sep) : row.raw);
  const serialize = () => rows.map(rowText).join('\n') + (endsWithNewline ? '\n' : '');

  function load(text) {
    const title = host.title();
    sep = /\.tsv$/i.test(title) ? '\t' : detectSeparator(text);
    rows = parse(text, sep);
    endsWithNewline = text.endsWith('\n');
    if (!rows.length) rows = [{ cells: [newCell()], raw: '', changed: true }];
    render();
  }

  /* ---------- Showing the table ---------- */

  function headerRow() {
    try { return JSON.parse(localStorage.getItem('viewer:csv:header')) ?? true; } catch { return true; }
  }

  function rowHtml(row, r, cols) {
    let html = `<tr${r === 0 && headerRow() ? ' class="live-csv-head"' : ''}><th class="live-csv-no">${r + 1}</th>`;
    for (let c = 0; c < cols; c++) {
      const value = row.cells[c]?.value ?? '';
      const text = value.replace(/[&<>]/g, (ch) => `&#${ch.charCodeAt(0)};`);
      html += `<td data-r="${r}" data-c="${c}"${disabled ? '' : ' contenteditable="plaintext-only"'} spellcheck="false">${text}</td>`;
    }
    return `${html}</tr>`;
  }

  function render(keepFocus = false) {
    const cols = columns();
    const upTo = Math.max(PAGE_ROWS, Math.min(rows.length, shown || PAGE_ROWS), current.r + 1);
    shown = Math.min(rows.length, upTo);
    let html = '';
    for (let r = 0; r < shown; r++) html += rowHtml(rows[r], r, cols);
    tbody.innerHTML = html;
    wrap.querySelector('.viewer-more')?.remove();
    if (shown < rows.length) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'viewer-more';
      more.textContent = `Show ${(rows.length - shown).toLocaleString()} more rows`;
      more.onclick = () => { shown = rows.length; render(); };
      wrap.append(more);
    }
    const dataRows = headerRow() ? rows.length - 1 : rows.length;
    info.textContent = `${dataRows.toLocaleString()} rows · ${cols} columns · separated by ${SEPARATOR_NAMES[sep]}`;
    if (keepFocus) focusCell(current.r, current.c);
  }

  function focusCell(r, c) {
    const td = tbody.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
    if (!td) return;
    td.focus();
    // Caret at the end of the cell
    const range = document.createRange();
    range.selectNodeContents(td);
    range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /* ---------- Changes ---------- */

  function remember() {
    undoStack.push(serialize());
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }

  function changed() {
    host.onInput();
  }

  function setCell(r, c, value) {
    const row = rows[r];
    while (row.cells.length <= c) row.cells.push(newCell());
    const cell = row.cells[c];
    cell.value = value;
    cell.changed = true;
    row.changed = true;
  }

  const OPS = {
    addRow() {
      rows.splice(current.r + 1, 0, { cells: Array.from({ length: columns() }, newCell), raw: '', changed: true });
      current = { r: current.r + 1, c: current.c };
    },
    deleteRow() {
      if (rows.length <= 1) return;
      rows.splice(current.r, 1);
      current = { r: Math.min(current.r, rows.length - 1), c: current.c };
    },
    addColumn() {
      const at = current.c + 1;
      for (const row of rows) {
        if (row.cells.length >= at) {
          row.cells.splice(at, 0, newCell());
          row.changed = true;
        }
      }
      current = { r: current.r, c: at };
    },
    deleteColumn() {
      if (columns() <= 1) return;
      for (const row of rows) {
        if (row.cells.length > current.c) {
          row.cells.splice(current.c, 1);
          row.changed = true;
        }
      }
      current = { r: current.r, c: Math.min(current.c, columns() - 1) };
    },
  };

  root.querySelector('.live-csv-actions').addEventListener('click', (e) => {
    const op = e.target.closest('button')?.dataset.op;
    if (!op || disabled) return;
    remember();
    typing = false;
    OPS[op]();
    render(true);
    changed();
  });
  // Keep the cell focused while clicking the buttons
  root.querySelector('.live-csv-actions').addEventListener('mousedown', (e) => e.preventDefault());

  tbody.addEventListener('focusin', (e) => {
    const td = e.target.closest('td[data-c]');
    if (!td) return;
    const r = Number(td.dataset.r);
    const c = Number(td.dataset.c);
    if (r !== current.r || c !== current.c) typing = false;
    current = { r, c };
  });

  tbody.addEventListener('input', (e) => {
    const td = e.target.closest('td[data-c]');
    if (!td) return;
    if (!typing) {
      // The state before this cell's edits, as one undo step
      const before = serialize();
      typing = true;
      undoStack.push(before);
      redoStack.length = 0;
    }
    setCell(Number(td.dataset.r), Number(td.dataset.c), td.innerText.replace(/\n$/, ''));
    changed();
  });

  tbody.addEventListener('keydown', (e) => {
    const td = e.target.closest('td[data-c]');
    if (!td) return;
    const r = Number(td.dataset.r);
    const c = Number(td.dataset.c);
    const cols = columns();
    if (e.key === 'Tab') {
      // Tab / Shift+Tab: next / previous cell, across rows
      e.preventDefault();
      let next = r * cols + c + (e.shiftKey ? -1 : 1);
      next = Math.max(0, Math.min(rows.length * cols - 1, next));
      if (Math.floor(next / cols) >= shown) { shown = rows.length; render(); }
      focusCell(Math.floor(next / cols), next % cols);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey) {
      // Enter: the cell below (Shift+Enter: a line break in the cell)
      e.preventDefault();
      if (r + 1 < rows.length) focusCell(r + 1, c);
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redoTable(); else undoTable();
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redoTable();
    }
  });

  function restore(text) {
    const { r, c } = current;
    load(text);
    current = { r: Math.min(r, rows.length - 1), c };
    render(true);
    typing = false;
    changed();
  }
  function undoTable() {
    if (!undoStack.length) return;
    redoStack.push(serialize());
    restore(undoStack.pop());
  }
  function redoTable() {
    if (!redoStack.length) return;
    undoStack.push(serialize());
    restore(redoStack.pop());
  }

  return {
    element: root,
    root,
    get value() { return serialize(); },
    /** Shows a file's text as a table (and starts a fresh undo history). */
    set value(text) {
      undoStack.length = 0;
      redoStack.length = 0;
      current = { r: 0, c: 0 };
      shown = 0;
      typing = false;
      load(text);
    },
    // A table has no text selection to speak of; the formatting toolbar isn't used for CSV.
    get selectionStart() { return 0; },
    get selectionEnd() { return 0; },
    setSelectionRange() {},
    replaceSelection() {},
    undo: undoTable,
    redo: redoTable,
    focus: () => focusCell(current.r, current.c),
    get disabled() { return disabled; },
    set disabled(value) {
      disabled = value;
      render();
    },
    get scrollTop() { return wrap.scrollTop; },
    set scrollTop(value) { wrap.scrollTop = value; },
    scrollBox: () => wrap,
    on: (type, fn) => root.addEventListener(type, fn),
  };
}
