// Read-mode viewers for common file types: text, JSON, CSV/TSV and XML.
// Loaded the first time such a file is shown, then kept. Each viewer has a "Raw" switch to the plain text.

const css = document.createElement('link');
css.rel = 'stylesheet';
css.href = '/__app/viewers.css';
document.head.append(css);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n) => n.toLocaleString();

const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');

const KINDS = { text: 'Text', code: 'Code', json: 'JSON', csv: 'CSV', xml: 'XML' };

/** Guesses from the content: XML if it starts with "<", JSON if it parses as JSON. */
function sniff(text) {
  const start = text.replace(/^﻿/, '').trimStart();
  if (start.startsWith('<')) return 'xml';
  if (start.startsWith('{') || start.startsWith('[')) {
    try {
      JSON.parse(text);
      return 'json';
    } catch { /* not JSON */ }
  }
  return null;
}

/**
 * What "Auto" picks: the file extension (kindByExt, from app.js), else a guess from the content,
 * else plain text or code.
 */
function autoKind(ext, text, kindByExt) {
  return kindByExt[ext] ?? sniff(text) ?? (ext === '' ? 'text' : 'code');
}

// The user's "View as" choice is remembered per extension, so e.g. every .bdm file opens as XML.
const choiceKey = (ext) => `viewAs:.${ext}`;

// How many levels of a JSON/XML tree start open. "Expand all" / "Collapse all" change it for this session.
const openDepth = { json: 2, xml: 3 };
const ALL_LEVELS = 1000;

// Children of big JSON/XML nodes and CSV rows are shown in chunks, so huge files stay responsive.
const CHUNK = 500;
const CSV_ROWS = 1000; // CSV: rows laid out to measure the table (see csvViewer)
const CSV_OVERSCAN = 30;
const TEXT_BLOCK = 200; // text: lines per block (see textViewer)

/**
 * Renders a file ({ title, text }) with its viewer into container.
 * @param {{ store: { get(k: string, d: any): any, set(k: string, v: any): void },
 *           highlightCode: (root: Element) => void, kindByExt: Record<string, string> }} host
 */
export function renderViewer(container, note, host) {
  const ext = extOf(note.title);
  const auto = autoKind(ext, note.text, host.kindByExt);
  const chosen = host.store.get(choiceKey(ext), null);
  const kind = KINDS[chosen] ? chosen : auto;
  // Read by the editor: Live mode offers a code editor for JSON and XML and a table for CSV (see editor.js).
  container.dataset.viewKind = kind;
  const rerender = () => renderViewer(container, note, host);
  // Tables and XML (long attribute values) use the full width.
  container.classList.toggle('viewer-wide', kind === 'csv' || kind === 'xml');
  container.innerHTML = `<div class="inline-title">${esc(note.title)}</div>`;

  const bar = div('viewer-bar');
  const info = document.createElement('span');
  info.className = 'viewer-info';
  const actions = div('viewer-actions');
  bar.append(info, actions);
  const body = div('viewer-body');
  container.append(bar, body);

  const ctx = { text: note.text, ext, body, info, actions, host, rerender };
  if (kind === 'code') {
    info.textContent = `${fmt(note.text.split('\n').length)} lines`;
    showRaw(ctx, ext);
  }
  const raw = kind !== 'text' && kind !== 'code' && host.store.get(`viewer:${kind}:raw`, false);
  if (kind !== 'text' && kind !== 'code') {
    button(actions, 'Raw', raw, () => {
      host.store.set(`viewer:${kind}:raw`, !raw);
      rerender();
    });
  }
  viewAsMenu(actions, ext, auto, chosen, host, rerender);
  if (kind === 'code') return;
  if (raw) {
    info.textContent = 'Raw text';
    showRaw(ctx);
    return;
  }
  ({ text: textViewer, json: jsonViewer, csv: csvViewer, xml: xmlViewer })[kind](ctx);
}

/** "View as" menu: Auto (shows what it picked) or a fixed viewer, remembered for this file extension. */
function viewAsMenu(actions, ext, auto, chosen, host, rerender) {
  const select = document.createElement('select');
  select.className = 'viewer-select';
  select.title = ext ? `How to show .${ext} files` : 'How to show files without an extension';
  select.innerHTML = `<option value="">Auto (${KINDS[auto]})</option>`
    + Object.entries(KINDS).map(([k, label]) => `<option value="${k}">${label}</option>`).join('');
  select.value = KINDS[chosen] ? chosen : '';
  select.onchange = () => {
    host.store.set(choiceKey(ext), select.value || null);
    rerender();
  };
  const label = document.createElement('label');
  label.className = 'viewer-view-as';
  label.append('View as ', select);
  actions.append(label);
}

function div(className) {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function button(parent, label, active, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.classList.toggle('active', !!active);
  if (active !== null) b.setAttribute('aria-pressed', String(!!active));
  b.onclick = onClick;
  parent.prepend(b);
  return b;
}

/** Plain text, highlighted by language when known (the file extension, or the given language). */
function showRaw({ text, ext, body, host }, language) {
  const lang = language ?? { json: 'json', xml: 'xml', svg: 'xml', config: 'xml', csproj: 'xml' }[ext];
  body.innerHTML = `<pre class="text-file"><code class="${lang && text.length < 300_000 ? `language-${lang}` : 'nohighlight'}">${esc(text)}</code></pre>`;
  host.highlightCode(body);
}

function showError({ info }, message) {
  info.innerHTML = `<span class="viewer-error">${esc(message)}</span>`;
}

/**
 * Calls next() once el (a "Show N more" row at the end of a branch) comes near the view: the next chunk is built as
 * you scroll down to it. Watches from the next frame, when el is in the page and its scrolling view is known.
 */
function nextChunkWhenNear(el, next) {
  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || !el.isConnected) return;
      observer.disconnect();
      next();
    }, { root: el.closest('.view'), rootMargin: '1000px 0px' });
    observer.observe(el);
  });
}

/** A "Show N more" row that calls more() when clicked. */
function moreButton(remaining, more) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'viewer-more';
  b.textContent = `Show ${fmt(remaining)} more`;
  b.onclick = () => {
    b.remove();
    more();
  };
  return b;
}

/* ---------- Text ---------- */

function textViewer({ text, body, info, actions, host, rerender }) {
  const wrap = wrapButton(actions, host, rerender);
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  info.textContent = `${fmt(lines.length)} lines · ${fmt(text.length)} characters`;
  showLineBlocks(body, {
    count: lines.length,
    blockSize: TEXT_BLOCK,
    wrap,
    lines: (from, n) => lines.slice(from, from + n),
    // Rows a block takes: with wrapping, a long line takes several
    rows: (from, n, perRow) => {
      if (!wrap) return n;
      let rows = 0;
      for (let i = from; i < Math.min(lines.length, from + n); i++) rows += Math.max(1, Math.ceil(lines[i].length / perRow));
      return rows;
    },
  });
}

function wrapButton(actions, host, rerender) {
  const wrap = host.store.get('viewer:text:wrap', true);
  button(actions, 'Wrap lines', wrap, () => {
    host.store.set('viewer:text:wrap', !wrap);
    rerender();
  });
  return wrap;
}

/**
 * Shows numbered lines in blocks of blockSize: only blocks near the view have their lines in the page, so a file of
 * any length opens and scrolls quickly. A block out of view keeps its height: measured once it has been shown, else
 * estimated by rows(from, n, charactersPerRow), calibrated on the first block. lines(from, n) gives a block's lines,
 * directly or as a promise (a large file's lines come from the host as they're needed).
 */
async function showLineBlocks(body, { count, blockSize, wrap, lines, rows, firstNo = 1, digits = String(count).length }) {
  const box = div('text-lines' + (wrap ? ' wrap' : ''));
  box.style.setProperty('--gutter', `${digits + 1}ch`);
  body.append(box);
  const blocks = [];
  for (let from = 0; from < count; from += blockSize) {
    const block = div('tl-block');
    block.dataset.from = from;
    blocks.push(block);
  }
  box.append(...blocks);
  if (!blocks.length) return;

  const sizeOf = (block) => Math.min(blockSize, count - Number(block.dataset.from));
  // Fills a block with its lines, unless it's no longer wanted by the time they're there
  const fill = async (block) => {
    block.wanted = true;
    if (block.filled || block.loading) return;
    block.loading = true;
    const from = Number(block.dataset.from);
    const text = await lines(from, sizeOf(block));
    block.loading = false;
    if (!block.wanted) return;
    let html = '';
    text.forEach((line, i) => {
      html += `<div class="tl"><span class="tl-no">${firstNo + from + i}</span><span class="tl-text">${esc(line) || ' '}</span></div>`;
    });
    block.innerHTML = html;
    block.style.height = '';
    block.filled = true;
  };
  await fill(blocks[0]);

  // Estimated heights from the first block: how many characters fit on a row, and a row's real height (a fraction
  // of a pixel off adds up over many lines)
  const probe = document.createElement('span');
  probe.className = 'tl-text';
  probe.textContent = 'x'.repeat(100);
  blocks[0].append(probe);
  const charWidth = probe.getBoundingClientRect().width / 100 || 8;
  probe.remove();
  const textWidth = (blocks[0].querySelector('.tl-text')?.getBoundingClientRect().width || box.clientWidth) - 4;
  const perRow = Math.max(20, Math.floor(textWidth / charWidth));
  const firstRows = rows(0, sizeOf(blocks[0]), perRow);
  const rowHeight = blocks[0].getBoundingClientRect().height / firstRows
    || blocks[0].querySelector('.tl-no')?.getBoundingClientRect().height || 21;
  for (const block of blocks.slice(1)) block.style.height = `${rows(Number(block.dataset.from), sizeOf(block), perRow) * rowHeight}px`;

  // Blocks get their lines as they come near the view, and give them up (keeping their height) once far from it
  const observer = new IntersectionObserver((entries) => {
    for (const { target: block, isIntersecting } of entries) {
      if (isIntersecting) fill(block);
      else {
        block.wanted = false;
        if (!block.filled) continue;
        block.style.height = `${block.getBoundingClientRect().height}px`;
        block.innerHTML = '';
        block.filled = false;
      }
    }
  }, { root: box.closest('.view'), rootMargin: '1500px 0px' });
  for (const block of blocks) observer.observe(block);
  return box;
}

// A browser page can only be so tall (about 33 million pixels): a file whose lines would be taller is shown in parts
// of about BIG_PART_PX each. The part each such file shows, while the app runs (kept when the file is re-shown).
const BIG_PART_PX = 20_000_000;
const bigParts = new Map();

/**
 * A text file too large to load whole (a big log): read-only, its lines read from the host in parts as they come into
 * view (see BigTextFile in the host). host.bigText: { index(): its line index, lines(from, count): their text }.
 */
export async function renderBigText(container, note, host) {
  container.dataset.viewKind = 'text';
  container.classList.add('viewer-wide');
  const rerender = () => renderBigText(container, note, host);
  container.innerHTML = `<div class="inline-title">${esc(note.title)}</div>`;
  const bar = div('viewer-bar');
  const info = document.createElement('span');
  info.className = 'viewer-info';
  const actions = div('viewer-actions');
  bar.append(info, actions);
  const body = div('viewer-body');
  container.append(bar, body);
  const mb = (bytes) => `${(bytes / 1048576).toLocaleString(undefined, { maximumFractionDigits: 0 })} MB`;
  info.textContent = `${mb(note.size)} · reading the file…`;

  const index = await host.bigText.index();
  if (!container.isConnected) return;
  const wrap = wrapButton(actions, host, rerender);
  const startOf = (line) => index.starts[Math.floor(line / index.step)] ?? index.size;

  // Lines per part: as many as fit in BIG_PART_PX (rows of about 21px; with wrapping, a long line takes several)
  const perRow = Math.max(40, Math.floor((body.clientWidth || 900) / 7.8) - 12);
  const rowsPerLine = wrap ? Math.max(1, index.size / Math.max(1, index.lines) / perRow) : 1;
  const partLines = Math.max(index.step, Math.floor(BIG_PART_PX / 21 / rowsPerLine / index.step) * index.step);
  const parts = Math.max(1, Math.ceil(index.lines / partLines));
  let part = Math.min(bigParts.get(note.path) ?? 0, parts - 1);
  const lineCount = (p) => Math.min(partLines, index.lines - p * partLines);
  // Blocks of a whole number of the index's steps, and no more than about 20,000 of them in the page
  const blockSize = index.step * Math.max(1, Math.ceil(lineCount(0) / index.step / 20000));

  const nav = div('big-parts');
  if (parts > 1) actions.prepend(nav);
  // scrollTo: 'start' or 'end' of the part (the part buttons); left as it is when the file is shown (again)
  const showPart = async (p, scrollTo = null) => {
    part = p;
    bigParts.set(note.path, p);
    const first = p * partLines;
    const count = lineCount(p);
    info.textContent = parts > 1
      ? `Lines ${fmt(first + 1)}–${fmt(first + count)} of ${fmt(index.lines)} · ${mb(index.size)} · Read only (too large to edit)`
      : `${fmt(index.lines)} lines · ${mb(index.size)} · Read only (too large to edit)`;
    nav.innerHTML = '';
    for (const [label, title, to, enabled] of [
      ['⇤', 'Start of the file', 0, p > 0],
      ['‹ Earlier', `Lines before ${fmt(first + 1)}`, p - 1, p > 0],
      ['Later ›', `Lines after ${fmt(first + count)}`, p + 1, p < parts - 1],
      ['⇥', 'End of the file', parts - 1, p < parts - 1],
    ]) {
      const b = button(nav, label, null, () => showPart(to, to === p - 1 || to === parts - 1 ? 'end' : 'start'));
      b.title = title;
      b.disabled = !enabled;
      nav.append(b); // in this order (button() puts each first)
    }
    body.replaceChildren();
    await showLineBlocks(body, {
      count,
      blockSize,
      wrap,
      firstNo: first + 1,
      digits: String(index.lines).length,
      lines: async (from, n) => (await host.bigText.lines(first + from, n)).split('\n'),
      // Rows a block takes, estimated from its size in bytes
      rows: (from, n, chars) => (wrap ? Math.max(n, Math.ceil((startOf(first + from + n) - startOf(first + from)) / chars)) : n),
    });
    const view = container.closest('.view');
    if (!view || !scrollTo) return;
    if (scrollTo === 'start') { view.scrollTop = 0; return; }
    // To the end: again once the last lines are in (their real heights replace the estimates), until it's settled
    for (let i = 0, last = -1; i < 20 && view.scrollHeight !== last; i++) {
      last = view.scrollHeight;
      view.scrollTop = last;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  await showPart(part);
}

/* ---------- JSON ---------- */

function jsonViewer(ctx) {
  const { text, body, info, actions, host, rerender } = ctx;
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    showError(ctx, `Not valid JSON: ${e.message}`);
    showRaw(ctx);
    return;
  }

  button(actions, 'Collapse all', null, () => { openDepth.json = 1; rerender(); });
  button(actions, 'Expand all', null, () => { openDepth.json = ALL_LEVELS; rerender(); });

  info.textContent = Array.isArray(data) ? `Array · ${fmt(data.length)} items`
    : data && typeof data === 'object' ? `Object · ${fmt(Object.keys(data).length)} keys`
      : 'Single value';
  const tree = div('tree json-tree');
  tree.append(jsonNode(null, data, 0, openDepth.json, true));
  body.append(tree);
}

function jsonValue(v) {
  if (v === null) return '<span class="j-null">null</span>';
  if (typeof v === 'string') return `<span class="j-str">${esc(JSON.stringify(v))}</span>`;
  if (typeof v === 'number') return `<span class="j-num">${v}</span>`;
  return `<span class="j-bool">${v}</span>`;
}

function jsonNode(key, value, depth, openDepth, last) {
  const keyHtml = key === null ? ''
    : typeof key === 'number' ? `<span class="j-index">${key}</span><span class="t-punct">: </span>`
      : `<span class="j-key">${esc(JSON.stringify(key))}</span><span class="t-punct">: </span>`;
  const comma = last ? '' : '<span class="t-punct">,</span>';

  if (value === null || typeof value !== 'object') {
    const row = div('t-row');
    row.innerHTML = `<span class="t-toggle"></span>${keyHtml}${jsonValue(value)}${comma}`;
    return row;
  }

  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value);
  const [openB, closeB] = isArray ? ['[', ']'] : ['{', '}'];
  if (!entries.length) {
    const row = div('t-row');
    row.innerHTML = `<span class="t-toggle"></span>${keyHtml}<span class="t-punct">${openB}${closeB}</span>${comma}`;
    return row;
  }

  return branch({
    head: `${keyHtml}<span class="t-punct">${openB}</span>`,
    summary: `<span class="t-summary">${fmt(entries.length)} ${isArray ? (entries.length === 1 ? 'item' : 'items') : (entries.length === 1 ? 'key' : 'keys')}</span><span class="t-punct">${closeB}</span>${comma}`,
    close: `<span class="t-punct">${closeB}</span>${comma}`,
    count: entries.length,
    child: (i) => jsonNode(entries[i][0], entries[i][1], depth + 1, openDepth, i === entries.length - 1),
    open: depth < openDepth,
  });
}

/**
 * A collapsible node: a head row (click to toggle), children built on first open (in chunks), a closing row.
 * Collapsed, the head row shows a summary instead.
 */
function branch({ head, summary, close, count, child, open }) {
  const node = div('t-node');
  const headRow = div('t-row t-head');
  headRow.innerHTML = `<span class="t-toggle">▸</span>${head}<span class="t-collapsed">${summary}</span>`;
  const kids = div('t-kids');
  const closeRow = div('t-row t-close');
  closeRow.innerHTML = `<span class="t-toggle"></span>${close}`;

  // Children are built in chunks of CHUNK: the first when the branch opens, each next one as the end of the last comes
  // near the view (or "Show N more" is clicked). Chunks out of view aren't laid out (content-visibility, viewers.css),
  // so a branch with many thousands of children stays quick.
  let built = 0;
  const build = (upTo) => {
    const end = Math.min(count, upTo);
    const chunk = div('t-chunk');
    for (; built < end; built++) chunk.append(child(built));
    kids.append(chunk);
    if (built < count) {
      const more = moreButton(count - built, () => build(built + CHUNK));
      kids.append(more);
      nextChunkWhenNear(more, () => { more.remove(); build(built + CHUNK); });
    }
  };
  const setOpen = (isOpen) => {
    node.classList.toggle('open', isOpen);
    if (isOpen && !built) build(CHUNK);
  };
  headRow.onclick = () => setOpen(!node.classList.contains('open'));
  setOpen(open);

  node.append(headRow, kids, closeRow);
  return node;
}

/* ---------- CSV / TSV ---------- */

const SEPARATORS = { ',': 'commas', ';': 'semicolons', '\t': 'tabs', '|': 'pipes' };

/** Picks the separator that occurs most often (outside quotes) in the first lines. */
function detectSeparator(text) {
  const sample = text.slice(0, 20000);
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let quoted = false;
  let lines = 0;
  for (const ch of sample) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch]++;
    else if (!quoted && ch === '\n' && ++lines >= 20) break;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    : ',';
}

/** RFC 4180 parsing: quoted fields may contain separators, line breaks and doubled quotes. */
function parseCsv(text, sep) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let quoted = false;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Number value for sorting: accepts "1234.5", "1,234.5" and Danish-style "1.234,5". */
function numberValue(s) {
  const t = s.trim();
  if (!/^[-+]?[\d.,\s]+$/.test(t) || !/\d/.test(t)) return NaN;
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  const normalized = lastComma > lastDot
    ? t.replace(/[.\s]/g, '').replace(',', '.')
    : t.replace(/[,\s]/g, '');
  return Number(normalized);
}

function csvViewer(ctx) {
  const { text, ext, body, info, actions, host, rerender } = ctx;
  const sep = ext === 'tsv' ? '\t' : detectSeparator(text);
  const rows = parseCsv(text, sep);
  const hasHeader = host.store.get('viewer:csv:header', true);
  button(actions, 'Header row', hasHeader, () => { host.store.set('viewer:csv:header', !hasHeader); rerender(); });

  const columns = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const header = hasHeader && rows.length ? rows[0] : null;
  const data = header ? rows.slice(1) : rows;
  info.textContent = `${fmt(data.length)} rows · ${fmt(columns)} columns · separated by ${SEPARATORS[sep]}`;

  const wrap = div('csv-wrap');
  const table = document.createElement('table');
  table.className = 'csv-table';
  wrap.append(table);
  body.append(wrap);

  let sort = { col: -1, dir: 1 };
  let order = data.map((_, i) => i);

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.innerHTML = '<th class="csv-no">#</th>';
  for (let c = 0; c < columns; c++) {
    const th = document.createElement('th');
    th.innerHTML = `<button type="button">${esc(header?.[c] ?? `Column ${c + 1}`)}<span class="csv-sort"></span></button>`;
    th.querySelector('button').onclick = () => sortBy(c);
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);
  const tbody = document.createElement('tbody');
  table.append(tbody);

  // Only the rows in view (and CSV_OVERSCAN around them) are in the page, between two spacers that stand in for the
  // rest, so a table of any length scrolls quickly. Column widths and the row height are measured once, on the first
  // CSV_ROWS rows laid out by the browser.
  const rowHtml = (n) => {
    const r = data[order[n]];
    let html = `<tr${n % 2 ? ' class="alt"' : ''}><td class="csv-no">${order[n] + 1}</td>`;
    for (let c = 0; c < columns; c++) {
      const v = r[c] ?? '';
      html += `<td${Number.isNaN(numberValue(v)) ? '' : ' class="csv-num"'}>${esc(v)}</td>`;
    }
    return `${html}</tr>`;
  };
  const spacer = (height) => (height > 0 ? `<tr class="csv-spacer"><td colspan="${columns + 1}" style="height:${height}px"></td></tr>` : '');
  let rowHeight = 0;
  let drawn = { from: 0, to: 0 };

  /** Lays out the first rows to measure column widths and the row height, then draws the rows in view. */
  function measure() {
    let html = '';
    for (let n = 0; n < Math.min(order.length, CSV_ROWS); n++) html += rowHtml(n);
    tbody.innerHTML = html;
    // The row number column needs room for the highest number, not only those in the first rows
    if (tbody.rows[0]) tbody.rows[0].cells[0].textContent = String(order.length);
    const widths = [...headRow.cells].map((cell) => Math.ceil(cell.getBoundingClientRect().width) + 1);
    if (!widths.some((w) => w > 1)) return; // not shown yet
    const colgroup = document.createElement('colgroup');
    for (const w of widths) colgroup.insertAdjacentHTML('beforeend', `<col style="width:${w}px">`);
    table.querySelector('colgroup')?.remove();
    table.prepend(colgroup);
    table.style.width = `${widths.reduce((a, b) => a + b, 0)}px`;
    table.style.tableLayout = 'fixed';
    // With the widths fixed, every row is one line high
    rowHeight = tbody.rows[0]?.getBoundingClientRect().height ?? 0;
    drawRows(true);
  }

  /** Draws the rows in view, unless they're drawn already (force: draw anyway). */
  function drawRows(force = false) {
    if (!rowHeight) return;
    const inView = Math.ceil(wrap.clientHeight / rowHeight) + 1;
    const at = Math.floor(wrap.scrollTop / rowHeight);
    const from = Math.max(0, at - CSV_OVERSCAN);
    const to = Math.min(order.length, at + inView + CSV_OVERSCAN);
    const wantFrom = Math.max(0, at - 2 * CSV_OVERSCAN);
    const wantTo = Math.min(order.length, at + inView + 2 * CSV_OVERSCAN);
    // Drawn already (and not far more than needed, as after the view got smaller)
    if (!force && from >= drawn.from && to <= drawn.to && drawn.to - drawn.from <= 2 * (wantTo - wantFrom)) return;
    let html = spacer(wantFrom * rowHeight);
    for (let n = wantFrom; n < wantTo; n++) html += rowHtml(n);
    tbody.innerHTML = html + spacer((order.length - wantTo) * rowHeight);
    drawn = { from: wantFrom, to: wantTo };
    // The spacers' heights assume every row is rowHeight high: check it on a drawn row (it can be measured before
    // the layout is final), and draw again with the real height if it's off
    const real = tbody.rows[wantFrom > 0 ? 1 : 0]?.getBoundingClientRect().height;
    if (real && Math.abs(real - rowHeight) > 0.5) {
      rowHeight = real;
      drawRows(true);
    }
  }

  let drawPending = false;
  wrap.addEventListener('scroll', () => {
    if (drawPending) return;
    drawPending = true;
    requestAnimationFrame(() => { drawPending = false; drawRows(); });
  });
  // Measured once the table is shown (it may be laid out while hidden); more rows in view when it grows
  new ResizeObserver(() => { if (!rowHeight) measure(); else drawRows(); }).observe(wrap);
  function sortBy(col) {
    sort = { col, dir: sort.col === col ? -sort.dir : 1 };
    const values = data.map((r) => r[col] ?? '');
    const numeric = values.every((v) => v.trim() === '' || !Number.isNaN(numberValue(v)));
    order = data.map((_, i) => i).sort((a, b) => {
      const x = values[a];
      const y = values[b];
      const cmp = numeric
        ? (numberValue(x) || 0) - (numberValue(y) || 0)
        : x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' });
      return cmp * sort.dir || a - b;
    });
    headRow.querySelectorAll('.csv-sort').forEach((s, i) => {
      s.textContent = i === col ? (sort.dir > 0 ? ' ▲' : ' ▼') : '';
    });
    drawRows(true);
  }

  measure();
}

/* ---------- XML ---------- */

function xmlViewer(ctx) {
  const { text, body, info, actions, host, rerender } = ctx;
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const error = doc.querySelector('parsererror');
  if (error) {
    showError(ctx, `Not valid XML: ${error.textContent.trim().split('\n')[0]}`);
    showRaw(ctx);
    return;
  }

  button(actions, 'Collapse all', null, () => { openDepth.xml = 1; rerender(); });
  button(actions, 'Expand all', null, () => { openDepth.xml = ALL_LEVELS; rerender(); });
  info.textContent = `Root <${doc.documentElement.nodeName}> · ${fmt(doc.getElementsByTagName('*').length)} elements`;

  const tree = div('tree xml-tree');
  const declaration = text.match(/^﻿?\s*(<\?xml[^?]*\?>)/);
  if (declaration) {
    const row = div('t-row');
    row.innerHTML = `<span class="t-toggle"></span><span class="x-pi">${esc(declaration[1])}</span>`;
    tree.append(row);
  }
  for (const node of doc.childNodes) {
    const el = xmlNode(node, 0, openDepth.xml);
    if (el) tree.append(el);
  }
  body.append(tree);
}

function xmlAttrs(el) {
  return [...el.attributes]
    .map((a) => ` <span class="x-attr">${esc(a.name)}</span><span class="t-punct">=</span><span class="x-val">"${esc(a.value)}"</span>`)
    .join('');
}

function xmlNode(node, depth, openDepth) {
  const row = (html) => {
    const r = div('t-row');
    r.innerHTML = `<span class="t-toggle"></span>${html}`;
    return r;
  };
  switch (node.nodeType) {
    case Node.TEXT_NODE: {
      const t = node.nodeValue.trim();
      return t ? row(`<span class="x-text">${esc(t)}</span>`) : null;
    }
    case Node.CDATA_SECTION_NODE:
      return row(`<span class="x-cdata">&lt;![CDATA[${esc(node.nodeValue)}]]&gt;</span>`);
    case Node.COMMENT_NODE:
      return row(`<span class="x-comment">&lt;!--${esc(node.nodeValue)}--&gt;</span>`);
    case Node.PROCESSING_INSTRUCTION_NODE:
      return row(`<span class="x-pi">&lt;?${esc(node.target)} ${esc(node.data)}?&gt;</span>`);
    case Node.DOCUMENT_TYPE_NODE: {
      const ids = (node.publicId ? ` PUBLIC "${node.publicId}"` : node.systemId ? ' SYSTEM' : '')
        + (node.systemId ? ` "${node.systemId}"` : '');
      return row(`<span class="x-pi">&lt;!DOCTYPE ${esc(node.name)}${esc(ids)}&gt;</span>`);
    }
    case Node.ELEMENT_NODE:
      break;
    default:
      return null;
  }

  const name = esc(node.nodeName);
  const open = `<span class="t-punct">&lt;</span><span class="x-tag">${name}</span>${xmlAttrs(node)}`;
  const closeTag = `<span class="t-punct">&lt;/</span><span class="x-tag">${name}</span><span class="t-punct">&gt;</span>`;
  const children = [...node.childNodes].filter((c) =>
    c.nodeType !== Node.TEXT_NODE || c.nodeValue.trim());

  if (!children.length) return row(`${open}<span class="t-punct"> /&gt;</span>`);
  // Element holding only a short text: keep it on one line.
  if (children.length === 1 && children[0].nodeType === Node.TEXT_NODE && children[0].nodeValue.trim().length <= 120) {
    return row(`${open}<span class="t-punct">&gt;</span><span class="x-text">${esc(children[0].nodeValue.trim())}</span>${closeTag}`);
  }

  return branch({
    head: `${open}<span class="t-punct">&gt;</span>`,
    summary: `<span class="t-summary">${fmt(children.length)} ${children.length === 1 ? 'child' : 'children'}</span>${closeTag}`,
    close: closeTag,
    count: children.length,
    child: (i) => xmlNode(children[i], depth + 1, openDepth) ?? document.createComment(''),
    open: depth < openDepth,
  });
}
