// Combining two sets of changes to the same text (a three-way merge, as git does): your unsaved edits and changes
// another program saved to the file, both made to the version you started from. Used by editor.js when a file you're
// editing changes on disk. Changes to different lines are combined; changes to the same lines (or right next to an
// insertion there) can't be, and are left for you to choose between.

/**
 * Where other differs from base: [{ from, to, lines }], each replacing base lines from..to-1 (from = to: inserting
 * before line from) with lines. ops: diffLines(base, other) from diff.js.
 */
function hunks(ops, other) {
  const out = [];
  let at = 0; // the base line the next op is at
  let hunk = null;
  for (const [op, i, j] of ops) {
    if (op === '=') {
      if (hunk) out.push(hunk);
      hunk = null;
      at = i + 1;
      continue;
    }
    hunk ??= { from: at, to: at, lines: [] };
    if (op === '-') {
      hunk.to = i + 1;
      at = i + 1;
    } else {
      hunk.lines.push(other[i]);
    }
  }
  if (hunk) out.push(hunk);
  return out;
}

const same = (a, b) => a.from === b.from && a.to === b.to && a.lines.length === b.lines.length
  && a.lines.every((line, k) => line === b.lines[k]);

/** True if two changes touch the same lines, so which one wins (or in what order they go) is a choice. */
function clash(a, b) {
  if (a.from === a.to || b.from === b.to) {
    const [ins, other] = a.from === a.to ? [a, b] : [b, a];
    return other.from <= ins.from && ins.from <= other.to;
  }
  return a.from < b.to && b.from < a.to;
}

/**
 * What changes before into after, as text changes [{ from, to, insert }] (offsets in before, in order), line by line:
 * applied to an editor, they keep the cursor and undo history where nothing changed. Checked: if applying them
 * doesn't give after exactly, one change replacing everything instead.
 */
export function textChanges(before, after, diffLines) {
  const whole = [{ from: 0, to: before.length, insert: after }];
  if (before === after) return [];
  // Worked out with a line break added at the end of both, so every line ends in one
  const a = before.split('\n');
  const b = after.split('\n');
  const starts = [];
  let offset = 0;
  for (const line of a) { starts.push(offset); offset += line.length + 1; }
  const at = (i) => (i < a.length ? starts[i] : before.length + 1);
  const changes = hunks(diffLines(a, b), b).map((h) => {
    let from = at(h.from);
    let to = at(h.to);
    let insert = h.lines.map((line) => `${line}\n`).join('');
    // Back to the texts as they are (no added line break at the end)
    if (from > before.length) { from = before.length; insert = `\n${insert.slice(0, -1)}`; to = before.length; }
    else if (to > before.length) {
      to = before.length;
      if (insert) insert = insert.slice(0, -1);
      else if (from > 0) from--; // the last lines removed: and the line break before them
    }
    return { from, to, insert };
  });
  let result = '';
  let pos = 0;
  for (const c of changes) { result += before.slice(pos, c.from) + c.insert; pos = c.to; }
  result += before.slice(pos);
  return result === after ? changes : whole;
}

/**
 * Your changes (mine) and someone else's (theirs), both made to base, in one text; or null if they change the same
 * lines. Texts use "\n" line breaks. diffLines: from diff.js.
 */
export function merge3(base, mine, theirs, diffLines) {
  if (mine === base) return theirs;
  if (theirs === base || theirs === mine) return mine;
  const baseLines = base.split('\n');
  const mineLines = mine.split('\n');
  const theirLines = theirs.split('\n');
  const a = hunks(diffLines(baseLines, mineLines), mineLines);
  const b = hunks(diffLines(baseLines, theirLines), theirLines);
  const out = [];
  let pos = 0;
  let ia = 0;
  let ib = 0;
  while (ia < a.length || ib < b.length) {
    const x = a[ia];
    const y = b[ib];
    if (x && y && clash(x, y)) {
      if (!same(x, y)) return null;
      ib++; // the same change on both sides: once
      continue;
    }
    const next = !y || (x && x.from <= y.from) ? a[ia++] : b[ib++];
    out.push(...baseLines.slice(pos, next.from), ...next.lines);
    pos = next.to;
  }
  out.push(...baseLines.slice(pos));
  return out.join('\n');
}
