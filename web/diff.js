// Side-by-side comparison of two files, for comparison tabs (see "Comparing files" in app.js).
// Loaded the first time a comparison is shown, then kept.

const css = document.createElement('link');
css.rel = 'stylesheet';
css.href = '/__app/diff.css';
document.head.append(css);

const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Unchanged lines kept around each change when the rest are folded away.
const CONTEXT = 3;
// Past this many differences the exact search stops (it would get slow and use a lot of memory) and the files are
// lined up on their unique lines instead (see patience).
const MAX_EDITS = 2000;
// Lines longer than this aren't compared word by word.
const MAX_WORD_DIFF_LENGTH = 5000;

/**
 * Shortest edit script between two sequences of numbers (Myers' algorithm): a list of
 * ['=', i, j] (a[i] equals b[j]), ['-', i] (a[i] removed) and ['+', j] (b[j] added), in order.
 */
function diff(a, b) {
  // Common start and end take no work.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const ops = [];
  for (let i = 0; i < start; i++) ops.push(['=', i, i]);
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle = myers(midA, midB) ?? patience(midA, midB);
  if (middle) {
    for (const [op, i, j] of middle) ops.push(op === '=' ? ['=', start + i, start + j] : [op, start + i]);
  } else {
    // Too different to match up: everything in between is a change.
    for (let i = start; i < endA; i++) ops.push(['-', i]);
    for (let j = start; j < endB; j++) ops.push(['+', j]);
  }
  for (let k = 0; endA + k < a.length; k++) ops.push(['=', endA + k, endB + k]);
  return ops;
}

/** Myers' greedy algorithm with a backtrace; null when there are more than MAX_EDITS differences. */
function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return Array.from({ length: m }, (_, j) => ['+', j]);
  if (m === 0) return Array.from({ length: n }, (_, i) => ['-', i]);
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  // v[offset + k]: the furthest x reached on diagonal k (x - y = k); -1 where none has been yet.
  const v = new Int32Array(2 * max + 3).fill(-1);
  v[offset + 1] = 0;
  // trace[d]: v for diagonals -d-1..d+1 before step d, for the backtrace.
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = step(v[offset + k + 1], v[offset + k - 1], k, n, m);
      if (x < 0) {
        v[offset + k] = -1;
        continue;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x === n && y === m) return backtrack(trace, n, m);
    }
  }
  return null;
}

/**
 * Where diagonal k starts in the next step: from diagonal k + 1 by adding a line of b (x stays), or from k - 1 by
 * removing a line of a (x + 1), whichever gets further while staying inside both texts; -1 if neither can.
 */
function step(fromAbove, fromLeft, k, n, m) {
  const canAdd = fromAbove >= 0 && fromAbove - (k + 1) + 1 <= m;
  const canRemove = fromLeft >= 0 && fromLeft + 1 <= n;
  if (canAdd && (!canRemove || fromAbove > fromLeft)) return fromAbove;
  return canRemove ? fromLeft + 1 : -1;
}

function backtrack(trace, n, m) {
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const at = (k) => v[k + d + 1];
    const k = x - y;
    // The same choice as the forward pass made for this diagonal.
    const start = step(at(k + 1), at(k - 1), k, n, m);
    const added = d > 0 && start === at(k + 1) && !(at(k - 1) >= 0 && at(k - 1) + 1 === start && at(k - 1) >= at(k + 1));
    const prevK = d === 0 ? 0 : added ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    // The diagonal run (equal lines) back to where this step started.
    const startX = d === 0 ? 0 : added ? prevX : prevX + 1;
    while (x > startX) ops.push(['=', --x, --y]);
    if (d > 0) {
      if (added) ops.push(['+', --y]);
      else ops.push(['-', --x]);
      x = prevX;
      y = prevY;
    }
  }
  return ops.reverse();
}

/**
 * For files too different for the exact search: lines that occur exactly once in each file and in the same order
 * (the longest such run) are matched first, and the stretches between them are compared on their own, like git's
 * "patience" diff. null if the files have no such lines in common.
 */
function patience(a, b) {
  const countA = new Map();
  const countB = new Map();
  for (const x of a) countA.set(x, (countA.get(x) ?? 0) + 1);
  b.forEach((x, j) => countB.set(x, countB.has(x) ? -1 : j)); // index of a line unique in b, or -1
  // Lines unique in both, in a's order, with their index in b.
  const pairs = [];
  a.forEach((x, i) => { if (countA.get(x) === 1 && countB.get(x) >= 0) pairs.push([i, countB.get(x)]); });
  if (!pairs.length) return null;

  // Longest run of those pairs that is in order in b too (patience sorting).
  const tails = [];      // tails[len]: index in pairs of the smallest b index ending a run of length len + 1
  const previous = [];   // previous[p]: the pair before p in its run
  pairs.forEach(([, j], p) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < j) lo = mid + 1; else hi = mid;
    }
    previous[p] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = p;
  });
  const anchors = [];
  for (let p = tails.at(-1); p >= 0; p = previous[p]) anchors.push(pairs[p]);
  anchors.reverse();

  const ops = [];
  let i0 = 0;
  let j0 = 0;
  for (const [i, j] of [...anchors, [a.length, b.length]]) {
    for (const [op, x, y] of diff(a.slice(i0, i), b.slice(j0, j))) {
      ops.push(op === '=' ? ['=', i0 + x, j0 + y] : op === '-' ? ['-', i0 + x] : ['+', j0 + x]);
    }
    if (i < a.length) ops.push(['=', i, j]);
    i0 = i + 1;
    j0 = j + 1;
  }
  return ops;
}

/** Maps strings to numbers (equal strings, equal numbers), so the diff compares numbers. */
function numbering() {
  const ids = new Map();
  return (s) => {
    let id = ids.get(s);
    if (id === undefined) ids.set(s, id = ids.size);
    return id;
  };
}

/**
 * The rows of a side-by-side view: { left, right } line indexes (null for no line on that side), with
 * type '=' (same), 'change' (a line replaced by another), '-' (only on the left) or '+' (only on the right).
 * Removed and added lines next to each other are paired up as changes.
 */
function alignRows(ops) {
  const rows = [];
  for (let i = 0; i < ops.length;) {
    if (ops[i][0] === '=') {
      rows.push({ type: '=', left: ops[i][1], right: ops[i][2] });
      i++;
      continue;
    }
    const removed = [];
    const added = [];
    for (; i < ops.length && ops[i][0] !== '='; i++) (ops[i][0] === '-' ? removed : added).push(ops[i][1]);
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      const left = removed[k] ?? null;
      const right = added[k] ?? null;
      rows.push({ type: left !== null && right !== null ? 'change' : left !== null ? '-' : '+', left, right, first: k === 0 });
    }
  }
  return rows;
}

/** A changed line pair as HTML, with the words that differ marked on each side. */
function wordDiff(before, after) {
  if (before.length + after.length > MAX_WORD_DIFF_LENGTH) return [esc(before), esc(after)];
  const split = (s) => s.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
  const a = split(before);
  const b = split(after);
  const id = numbering();
  const ops = diff(a.map(id), b.map(id));
  let left = '';
  let right = '';
  for (const [op, i, j] of ops) {
    if (op === '=') { left += esc(a[i]); right += esc(b[j]); }
    else if (op === '-') left += `<span class="w-del">${esc(a[i])}</span>`;
    else right += `<span class="w-ins">${esc(b[i])}</span>`;
  }
  return [left, right];
}

/**
 * Shows a comparison of two files in container.
 * @param {{ left: object, right: object }} sides
 * @param {{ store: { get(k: string, d: any): any, set(k: string, v: any): void },
 *           load: (side: object) => Promise<{ text?: string, error?: string }>,
 *           label: (side: object) => string, swap: () => void, isCurrent: () => boolean }} host
 */
export async function renderDiff(container, sides, host) {
  container.classList.add('diff-wide');
  container.innerHTML = '<div class="diff-status">Comparing…</div>';
  const [left, right] = await Promise.all([host.load(sides.left), host.load(sides.right)]);
  if (!host.isCurrent()) return;

  const header = `
    <div class="diff-head">
      <div class="diff-side diff-side-left" title="${esc(host.label(sides.left))}"><span class="diff-sign">−</span>${esc(host.label(sides.left))}</div>
      <div class="diff-side diff-side-right" title="${esc(host.label(sides.right))}"><span class="diff-sign">+</span>${esc(host.label(sides.right))}</div>
    </div>`;
  const errors = [left.error && `${host.label(sides.left)}: ${left.error}`, right.error && `${host.label(sides.right)}: ${right.error}`].filter(Boolean);
  if (errors.length) {
    container.innerHTML = header + errors.map((e) => `<div class="diff-status diff-error">${esc(e)}</div>`).join('');
    return;
  }

  // Line endings don't count as a difference (Git and editors change them freely); they are mentioned instead.
  const leftLines = left.text.replace(/\r\n/g, '\n').split('\n');
  const rightLines = right.text.replace(/\r\n/g, '\n').split('\n');
  const id = numbering();
  const rows = alignRows(diff(leftLines.map(id), rightLines.map(id)));
  const removed = rows.filter((r) => r.type === '-' || r.type === 'change').length;
  const added = rows.filter((r) => r.type === '+' || r.type === 'change').length;
  const changes = rows.filter((r) => r.first).length;

  let summary;
  if (changes === 0) {
    summary = left.text === right.text ? 'The files are identical.' : 'The files differ only in line endings.';
  } else {
    summary = `${changes} ${changes === 1 ? 'change' : 'changes'}: <span class="diff-removed">−${removed}</span> <span class="diff-added">+${added}</span> lines`;
  }
  const showAll = host.store.get('diffShowAll', false);
  container.innerHTML = `${header}
    <div class="diff-bar">
      <span class="diff-summary">${summary}</span>
      <span class="diff-actions">
        ${changes ? `<button data-action="prev" title="Previous change (Shift+F7)">↑ Previous</button>
        <button data-action="next" title="Next change (F7)">↓ Next</button>
        <button data-action="all" class="${showAll ? 'active' : ''}" title="Show the unchanged lines too">Unchanged lines</button>` : ''}
        <button data-action="swap" title="Swap left and right">⇄ Swap</button>
      </span>
    </div>
    <table class="diff-table">
      <colgroup><col class="diff-ln"><col><col class="diff-ln"><col></colgroup>
      <tbody>${tableRows(rows, leftLines, rightLines, showAll)}</tbody>
    </table>`;

  container.querySelector('.diff-bar').addEventListener('click', (e) => {
    const action = e.target.closest('button')?.dataset.action;
    if (action === 'prev' || action === 'next') goToChange(container, action === 'next' ? 1 : -1);
    else if (action === 'swap') host.swap();
    else if (action === 'all') {
      host.store.set('diffShowAll', !host.store.get('diffShowAll', false));
      renderDiff(container, sides, host);
    }
  });
  // Folded unchanged lines open on click.
  container.querySelector('.diff-table').addEventListener('click', (e) => {
    const fold = e.target.closest('tr.diff-fold');
    if (!fold) return;
    const [from, to] = fold.dataset.rows.split('-').map(Number);
    fold.outerHTML = rows.slice(from, to).map((r, i) => rowHtml(r, from + i, leftLines, rightLines)).join('');
  });
}

/** The table rows; unless showAll, runs of unchanged lines away from any change are folded into one row. */
function tableRows(rows, leftLines, rightLines, showAll) {
  const near = new Uint8Array(rows.length);
  rows.forEach((r, i) => {
    if (r.type === '=') return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++) near[k] = 1;
  });
  let html = '';
  for (let i = 0; i < rows.length;) {
    if (showAll || near[i] || rows[i].type !== '=') {
      html += rowHtml(rows[i], i, leftLines, rightLines);
      i++;
      continue;
    }
    let end = i;
    while (end < rows.length && !near[end] && rows[end].type === '=') end++;
    // Folding a line or two saves nothing.
    if (end - i <= 2) {
      for (; i < end; i++) html += rowHtml(rows[i], i, leftLines, rightLines);
      continue;
    }
    const count = end - i;
    html += `<tr class="diff-fold" data-rows="${i}-${end}"><td colspan="4">⋯ ${count} unchanged lines</td></tr>`;
    i = end;
  }
  return html;
}

function rowHtml(row, index, leftLines, rightLines) {
  // The first row of each change is where Next/Previous stop.
  const start = row.type !== '=' && row.first ? ' diff-start' : '';
  let leftHtml = row.left !== null ? esc(leftLines[row.left]) : '';
  let rightHtml = row.right !== null ? esc(rightLines[row.right]) : '';
  if (row.type === 'change') [leftHtml, rightHtml] = wordDiff(leftLines[row.left], rightLines[row.right]);
  const side = (n, html, cls) => n === null
    ? '<td class="diff-ln"></td><td class="diff-code diff-empty"></td>'
    : `<td class="diff-ln">${n + 1}</td><td class="diff-code ${cls}">${html || ' '}</td>`;
  const leftCls = row.type === '=' ? '' : row.left !== null ? 'diff-del' : '';
  const rightCls = row.type === '=' ? '' : row.right !== null ? 'diff-ins' : '';
  return `<tr class="diff-row${start}" data-row="${index}">${side(row.left, leftHtml, leftCls)}${side(row.right, rightHtml, rightCls)}</tr>`;
}

/** Scrolls to the next (step 1) or previous (step -1) change below or above the top of the view. */
export function goToChange(container, step) {
  const view = container.closest('.view');
  const starts = [...container.querySelectorAll('tr.diff-start')];
  if (!starts.length) return;
  const top = view.getBoundingClientRect().top + 48;
  const positions = starts.map((tr) => tr.getBoundingClientRect().top);
  const target = step > 0
    ? starts.find((tr, i) => positions[i] > top + 1) ?? starts[0]
    : [...starts].reverse().find((tr) => tr.getBoundingClientRect().top < top - 1) ?? starts.at(-1);
  view.scrollTop += target.getBoundingClientRect().top - top;
}
