// Live mode for CSV and TSV files: edit the table directly. The file stays CSV with its own separator; rows and cells
// you don't change are written back exactly as they were, so saving doesn't reformat the file.
// Loaded by editor.js the first time a pane needs it.

const css = document.createElement('link');
css.rel = 'stylesheet';
css.href = '/__app/live.css';
document.head.append(css);
// The CSV viewer's styles (summary bar, buttons); usually loaded already, with viewers.js
if (!document.querySelector('link[href="/__app/viewers.css"]')) {
  const viewerCss = document.createElement('link');
  viewerCss.rel = 'stylesheet';
  viewerCss.href = '/__app/viewers.css';
  document.head.append(viewerCss);
}

const SEPARATOR_NAMES = { ',': 'commas', ';': 'semicolons', '\t': 'tabs', '|': 'pipes' };
// Rows laid out to measure column widths and the row height; rows drawn beyond those in view (see drawRows)
const MEASURE_ROWS = 1000;
const OVERSCAN = 30;

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

/** A number, as the CSV viewer reads them (right-aligned): "1234.5", "1,234.5" or Danish-style "1.234,5". */
function isNumber(s) {
  const t = s.trim();
  if (!/^[-+]?[\d.,\s]+$/.test(t) || !/\d/.test(t)) return false;
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  const normalized = lastComma > lastDot ? t.replace(/[.\s]/g, '').replace(',', '.') : t.replace(/[,\s]/g, '');
  return !Number.isNaN(Number(normalized));
}

/**
 * Creates the table editor inside parent, with the same "surface" as the other editors (see editor.js).
 * @param {{ onInput: () => void, title: () => string }} host title gives the file name (TSV files use tabs)
 */
export function createCsvSurface(parent, host) {
  const root = document.createElement('div');
  root.className = 'live-csv';
  root.innerHTML = `
    <div class="inline-title"></div>
    <div class="viewer-bar live-csv-bar">
      <span class="viewer-info live-csv-info"></span>
      <span class="viewer-actions live-csv-actions">
        <button type="button" data-op="addRow" title="Add a row below the current one">+ Row</button>
        <button type="button" data-op="deleteRow" title="Delete the current row">− Row</button>
        <button type="button" data-op="addColumn" title="Add a column right of the current one">+ Column</button>
        <button type="button" data-op="deleteColumn" title="Delete the current column">− Column</button>
      </span>
    </div>
    <div class="live-csv-wrap"><table class="live-csv-table"><colgroup></colgroup><tbody></tbody></table></div>`;
  parent.append(root);
  const info = root.querySelector('.live-csv-info');
  const wrap = root.querySelector('.live-csv-wrap');
  const table = root.querySelector('table');
  const colgroup = root.querySelector('colgroup');
  const tbody = root.querySelector('tbody');

  let sep = ',';
  let rows = [];
  let endsWithNewline = false;
  let disabled = true;
  let current = { r: 0, c: 0 }; // the cell last edited or focused
  const undoStack = [];
  const redoStack = [];
  let typing = false; // edits in one cell, until another cell gets focus, are one undo step
  // For telling quickly whether the table still equals a text (see differs)
  let base = '';            // the text the rows were read from
  let restructured = false; // rows or columns added or removed since
  const edited = new Set(); // rows with edited cells since

  const columns = () => {
    let n = 1;
    for (const row of rows) if (row.cells.length > n) n = row.cells.length;
    return n;
  };

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
    root.querySelector('.inline-title').textContent = title;
    sep = /\.tsv$/i.test(title) ? '\t' : detectSeparator(text);
    rows = parse(text, sep);
    endsWithNewline = text.endsWith('\n');
    base = text;
    restructured = false;
    edited.clear();
    if (!rows.length) rows = [{ cells: [newCell()], raw: '', changed: true }];
    render();
  }

  /* ---------- Showing the table ---------- */

  function headerRow() {
    try { return JSON.parse(localStorage.getItem('viewer:csv:header')) ?? true; } catch { return true; }
  }

  const escape = (s) => s.replace(/[&<>]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  // A cell shows on one line, as in the CSV viewer (line breaks as spaces); the cell you're in shows its real text.
  // (Editable cells always show line breaks, so a cell with them gets its text swapped on entering and leaving.)
  const oneLine = (s) => s.replace(/\n/g, ' ');

  // Numbered as in the CSV viewer: "#" on the header row, data rows from 1, every other one shaded
  function rowHtml(row, r, cols, header) {
    const head = header && r === 0;
    const no = header ? r : r + 1;
    let html = `<tr${head ? ' class="live-csv-head"' : no % 2 === 0 ? ' class="alt"' : ''}><th class="live-csv-no">${head ? '#' : no}</th>`;
    for (let c = 0; c < cols; c++) {
      const value = row.cells[c]?.value ?? '';
      const text = escape(oneLine(value));
      const num = !head && isNumber(value) ? ' class="csv-num"' : '';
      html += `<td data-r="${r}" data-c="${c}"${num}${disabled ? '' : ' contenteditable="plaintext-only"'} spellcheck="false">${text}</td>`;
    }
    return `${html}</tr>`;
  }

  // Only the rows in view (and OVERSCAN around them) are in the page, between two spacers that stand in for the
  // rest, so a table of any length scrolls and edits quickly. Column widths and the row height are measured once,
  // on the first MEASURE_ROWS rows laid out by the browser. The header row, if any, is always in the page (sticky).
  let colCount = 1;
  let rowHeight = 0; // 0 until the table has been shown (then it's measured)
  let drawn = { from: 0, to: 0 }; // the rows in the page, besides the header row
  const firstBodyRow = () => (headerRow() ? 1 : 0);

  /** Lays the table out (a file shown, columns added or removed, undo): measures it, then draws the rows in view. */
  function render(keepFocus = false) {
    colCount = columns();
    const header = headerRow();
    table.classList.toggle('has-head', header);
    const top = wrap.scrollTop;
    let html = '';
    for (let r = 0; r < Math.min(rows.length, MEASURE_ROWS); r++) html += rowHtml(rows[r], r, colCount, header);
    tbody.innerHTML = html;
    // The row number column needs room for the highest number, not only those in the first rows
    const numbered = tbody.rows[header && tbody.rows.length > 1 ? 1 : 0];
    if (numbered) numbered.cells[0].textContent = String(rows.length);
    fixWidths();
    rowHeight = tbody.rows[Math.min(firstBodyRow(), tbody.rows.length - 1)]?.getBoundingClientRect().height ?? 0;
    const dataRows = header ? rows.length - 1 : rows.length;
    info.textContent = `${dataRows.toLocaleString()} rows · ${colCount} columns · separated by ${SEPARATOR_NAMES[sep]}`;
    drawRows(true);
    wrap.scrollTop = top;
    drawRows();
    if (keepFocus) focusCell(current.r, current.c);
  }

  const spacer = (height) => (height > 0
    ? `<tr class="live-csv-spacer"><td colspan="${colCount + 1}" style="height:${height}px"></td></tr>` : '');

  /** Draws the rows in view, unless they're drawn already (force: draw anyway). Keeps the cell being edited. */
  function drawRows(force = false) {
    if (!rowHeight) return; // not shown yet: render() draws once it is (see the ResizeObserver below)
    const first = firstBodyRow();
    const inView = Math.ceil(wrap.clientHeight / rowHeight) + 1;
    const at = first + Math.floor(wrap.scrollTop / rowHeight);
    const from = Math.max(first, at - OVERSCAN);
    const to = Math.min(rows.length, at + inView + OVERSCAN);
    const wantFrom = Math.max(first, at - 2 * OVERSCAN);
    const wantTo = Math.min(rows.length, at + inView + 2 * OVERSCAN);
    // Drawn already (and not far more than needed, as after the view got smaller)
    if (!force && from >= drawn.from && to <= drawn.to && drawn.to - drawn.from <= 2 * (wantTo - wantFrom)) return;

    const editing = document.activeElement?.closest?.('td[data-r]');
    const caret = editing && tbody.contains(editing) ? getSelection().focusOffset : null;
    const header = headerRow();
    let html = header && rows.length ? rowHtml(rows[0], 0, colCount, true) : '';
    html += spacer((wantFrom - first) * rowHeight);
    for (let r = wantFrom; r < wantTo; r++) html += rowHtml(rows[r], r, colCount, header);
    html += spacer((rows.length - wantTo) * rowHeight);
    tbody.innerHTML = html;
    drawn = { from: wantFrom, to: wantTo };
    // The spacers' heights assume every row is rowHeight high: check it on a drawn row, and draw again if it's off
    const sample = [...tbody.rows].find((tr) => !tr.classList.contains('live-csv-head') && !tr.classList.contains('live-csv-spacer'));
    const real = sample?.getBoundingClientRect().height;
    if (real && Math.abs(real - rowHeight) > 0.5 && !editing) {
      rowHeight = real;
      drawRows(true);
      return;
    }
    if (caret !== null) {
      const td = tbody.querySelector(`td[data-r="${editing.dataset.r}"][data-c="${editing.dataset.c}"]`);
      if (td) {
        td.focus();
        const text = td.firstChild;
        if (text) getSelection().collapse(text, Math.min(caret, text.length));
      }
    }
  }

  let drawPending = false;
  wrap.addEventListener('scroll', () => {
    if (drawPending) return;
    drawPending = true;
    requestAnimationFrame(() => { drawPending = false; drawRows(); });
  });
  // Measured once the table is shown (it may be laid out while hidden); more rows in view when it grows
  new ResizeObserver(() => { if (!rowHeight && rows.length) render(); else drawRows(); }).observe(wrap);

  // Column widths are measured once with the browser's automatic table layout, then fixed: with automatic layout,
  // every keystroke in a cell makes the browser lay out the whole table again (slow with many rows).
  function fixWidths() {
    table.style.tableLayout = '';
    table.style.width = '';
    colgroup.replaceChildren();
    const first = tbody.rows[0];
    if (!first) return;
    const widths = [...first.cells].map((cell) => Math.ceil(cell.getBoundingClientRect().width) + 1);
    if (!widths.some((w) => w > 1)) return; // not shown right now: keep the automatic layout
    for (const w of widths) {
      const col = document.createElement('col');
      col.style.width = `${w}px`;
      colgroup.append(col);
    }
    table.style.width = `${widths.reduce((a, b) => a + b, 0)}px`;
    table.style.tableLayout = 'fixed';
  }

  function focusCell(r, c) {
    // A row out of view isn't in the page: scroll to it first
    if (rowHeight && !(headerRow() && r === 0) && (r < drawn.from || r >= drawn.to)) {
      wrap.scrollTop = (r - firstBodyRow()) * rowHeight - wrap.clientHeight / 3;
      drawRows(true);
    }
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
    edited.add(row);
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
    restructured = true;
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
    const value = rows[r]?.cells[c]?.value ?? '';
    if (value.includes('\n')) {
      td.textContent = value;
      getSelection().selectAllChildren(td);
      getSelection().collapseToEnd();
    }
  });
  tbody.addEventListener('focusout', (e) => {
    const td = e.target.closest('td[data-c]');
    const value = td && rows[Number(td.dataset.r)]?.cells[Number(td.dataset.c)]?.value;
    if (value?.includes('\n')) td.textContent = oneLine(value);
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
    const value = td.innerText.replace(/\n$/, '');
    setCell(Number(td.dataset.r), Number(td.dataset.c), value);
    if (!td.closest('.live-csv-head')) td.classList.toggle('csv-num', isNumber(value));
    changed();
  });

  tbody.addEventListener('keydown', (e) => {
    const td = e.target.closest('td[data-c]');
    if (!td) return;
    const r = Number(td.dataset.r);
    const c = Number(td.dataset.c);
    const cols = colCount;
    if (e.key === 'Tab') {
      // Tab / Shift+Tab: next / previous cell, across rows
      e.preventDefault();
      let next = r * cols + c + (e.shiftKey ? -1 : 1);
      next = Math.max(0, Math.min(rows.length * cols - 1, next));
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

  /** True if the table's text differs from text, without writing out the whole table on every keystroke. */
  function differs(text) {
    if (text === base) return restructured || [...edited].some((row) => rowText(row) !== row.raw);
    if (serialize() !== text) return true;
    settle(text);
    return false;
  }

  // The table equals text (just saved): edited rows take their current text as their original, for quick comparing.
  function settle(text) {
    for (const row of rows) {
      if (!row.changed) continue;
      for (const cell of row.cells) {
        cell.raw = cellText(cell);
        cell.changed = false;
      }
      row.raw = row.cells.map((cell) => cell.raw).join(sep);
      row.changed = false;
    }
    base = text;
    restructured = false;
    edited.clear();
  }

  return {
    element: root,
    differs,
    root,
    get value() { return serialize(); },
    /** Shows a file's text as a table (and starts a fresh undo history). */
    set value(text) {
      undoStack.length = 0;
      redoStack.length = 0;
      current = { r: 0, c: 0 };
      wrap.scrollTop = 0;
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
