// Live mode for JSON and XML files: the file's text, editable, looking like the JSON and XML viewers in Read mode
// (viewers.js): the file name and a summary on top, ▸ arrows to collapse a branch, a "3 keys" summary where one is
// collapsed, guide lines per level, the same colours, and the same levels open at first. JSON syntax errors are
// marked as you type. Loaded by editor.js the first time a pane needs it.
import {
  EditorState, Compartment,
  EditorView, Decoration, ViewPlugin, WidgetType, keymap,
  defaultKeymap, history, historyKeymap, indentWithTab, undo, redo,
  syntaxTree, syntaxHighlighting, HighlightStyle, ensureSyntaxTree, bracketMatching, indentOnInput,
  codeFolding, foldable, foldEffect, unfoldEffect, foldedRanges, unfoldAll, foldKeymap,
  closeBrackets, closeBracketsKeymap, linter,
  json, jsonParseLinter, xml, tags,
} from '/__app/codemirror.js';

const css = document.createElement('link');
css.rel = 'stylesheet';
css.href = '/__app/live.css';
document.head.append(css);
// The Read view's tree styles (summary bar, buttons, colours); usually loaded already, with viewers.js
if (!document.querySelector('link[href="/__app/viewers.css"]')) {
  const viewerCss = document.createElement('link');
  viewerCss.rel = 'stylesheet';
  viewerCss.href = '/__app/viewers.css';
  document.head.append(viewerCss);
}

// The same colours as the JSON and XML viewers (--v-* in viewers.css; fallbacks if that isn't loaded yet).
const codeStyle = HighlightStyle.define([
  { tag: [tags.propertyName, tags.tagName], color: 'var(--accent)' },
  { tag: tags.attributeName, color: 'var(--v-attr, #b45309)' },
  { tag: [tags.string, tags.attributeValue], color: 'var(--v-str, #0a7a3a)' },
  { tag: tags.number, color: 'var(--v-num, #1d4ed8)' },
  { tag: [tags.bool, tags.null, tags.keyword], color: 'var(--v-lit, #9333ea)' },
  { tag: [tags.comment, tags.processingInstruction, tags.documentMeta], color: 'var(--faint)', fontStyle: 'italic' },
  { tag: [tags.angleBracket, tags.separator, tags.punctuation, tags.brace, tags.squareBracket], color: 'var(--faint)' },
]);

// Width of one level, as in the Read view's trees (.t-kids in viewers.css: 18px padding, 7px margin, 1px line)
const LEVEL_PX = 26;
// Levels open at first, as in the Read view (openDepth in viewers.js)
const OPEN_DEPTH = { json: 2, xml: 3 };
// Time allowed for reading the whole file's structure before collapsing levels. Big files that take longer start
// fully expanded, so opening them stays quick; "Collapse all" may take longer.
const OPEN_BUDGET_MS = 150;
const BUTTON_BUDGET_MS = 5000;
// Files bigger than this can't be read in OPEN_BUDGET_MS anyway (about 10 MB/s), so they don't try
const OPEN_FOLD_MAX = 1_500_000;
// Lines longer than this show only their start, followed by how much is hidden, and files with them don't wrap
// lines (wrapping a huge line takes seconds). Read mode shows such lines in full.
const LONG_LINE = 10_000;
const LONG_LINE_SHOWN = 1_000;
// Lines longer than this are read-only here: a keystroke in one re-reads the whole line (about 10 ms per 500,000
// characters). Other lines in the file stay editable. A minified file (all on one line) can be spread over lines
// with Format.
const EDIT_MAX_LINE = 500_000;

const JSON_VALUES = new Set(['Object', 'Array', 'String', 'Number', 'True', 'False', 'Null']);
const XML_CHILDREN = new Set(['Element', 'Comment', 'Cdata', 'ProcessingInst']);

/** The parts of a language the tree look needs: which nodes are branches, their size and their collapsible range. */
const KINDS = {
  json: {
    language: () => json(),
    isBranch: (node) => node.name === 'Object' || node.name === 'Array',
    summary(node) {
      let n = 0;
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (node.name === 'Object' ? c.name === 'Property' : JSON_VALUES.has(c.name)) n++;
      }
      return node.name === 'Object' ? `${n.toLocaleString()} ${n === 1 ? 'key' : 'keys'}` : `${n.toLocaleString()} ${n === 1 ? 'item' : 'items'}`;
    },
    range: (node) => ({ from: node.from + 1, to: node.to - 1 }),
    valid(text) {
      try { JSON.parse(text); return true; } catch { return false; }
    },
    // reflowJson drops all spaces between values, a line break at the end too: kept as the text had it
    layout: (text, layout) => reflowJson(text, layout) + (text.endsWith('\n') ? '\n' : ''),
  },
  xml: {
    valid: (text) => !new DOMParser().parseFromString(text, 'application/xml').querySelector('parsererror'),
    layout: (text, layout) => reflowXml(text, layout),
    language: () => xml(),
    isBranch: (node) => node.name === 'Element' && node.firstChild?.name === 'OpenTag',
    summary(node, state) {
      let n = 0;
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (XML_CHILDREN.has(c.name) || (c.name === 'Text' && state.sliceDoc(c.from, c.to).trim())) n++;
      }
      return `${n.toLocaleString()} ${n === 1 ? 'child' : 'children'}`;
    },
    range(node) {
      const close = node.lastChild?.name === 'CloseTag' ? node.lastChild.from : node.to;
      return { from: node.firstChild.to, to: close };
    },
  },
};

/** The ▸ before each line (or an empty space of the same width, so lines line up as in the Read view). */
class Toggle extends WidgetType {
  constructor(state) { super(); this.state = state; } // 'open', 'closed' or '' (nothing to collapse)
  eq(other) { return other.state === this.state; }
  toDOM() {
    const el = document.createElement('span');
    el.className = `cm-tree-toggle ${this.state}`;
    if (this.state) el.textContent = '▸';
    return el;
  }
  ignoreEvent() { return false; }
}

/** What follows the start of a long line: how much of it is hidden. */
class More extends WidgetType {
  constructor(count) { super(); this.count = count; }
  eq(other) { return other.count === this.count; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-long-more';
    el.textContent = `… ${this.count.toLocaleString()} more characters on this line`;
    el.title = 'Long lines show only their start here. Read mode shows all of it; for JSON, Format spreads it over lines.';
    return el;
  }
}

/**
 * Lays out JSON again. layout: 'minified' (one line, no spaces), 'inline' (one line, a space after "," and ":"), or
 * the text for one level of indentation (spread over lines; base: the indentation of the first line, for a branch
 * inside a file). Only the spaces and line breaks between values change: strings, numbers and escapes are kept
 * exactly as written.
 */
function reflowJson(text, layout, base = '') {
  const out = [];
  const pad = [];
  const spread = layout !== 'minified' && layout !== 'inline';
  const newline = (depth) => (spread ? (pad[depth] ??= '\n' + base + layout.repeat(depth)) : '');
  const comma = layout === 'inline' ? ', ' : ',';
  let depth = 0;
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === '"') {
      // A string, to its closing quote (one not escaped by an odd number of backslashes)
      let end = i + 1;
      for (;;) {
        end = text.indexOf('"', end);
        if (end === -1) { end = text.length; break; }
        let slashes = 0;
        while (text[end - 1 - slashes] === '\\') slashes++;
        if (slashes % 2 === 0) break;
        end++;
      }
      out.push(text.slice(i, end + 1));
      i = end + 1;
    } else if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
      i++;
    } else if (ch === '{' || ch === '[') {
      let next = i + 1;
      while (' \n\r\t'.includes(text[next]) && next < text.length) next++;
      if (text[next] === (ch === '{' ? '}' : ']')) {
        out.push(ch + text[next]); // empty: {} or []
        i = next + 1;
      } else {
        depth++;
        out.push(ch + newline(depth));
        i++;
      }
    } else if (ch === '}' || ch === ']') {
      depth--;
      out.push(newline(depth) + ch);
      i++;
    } else if (ch === ',') {
      out.push(spread ? ',' + newline(depth) : comma);
      i++;
    } else if (ch === ':') {
      out.push(layout === 'minified' ? ':' : ': ');
      i++;
    } else {
      // A number, true, false or null
      let end = i;
      while (end < text.length && !',:{}[]" \n\r\t'.includes(text[end])) end++;
      out.push(text.slice(i, end));
      i = end;
    }
  }
  return out.join('');
}

/**
 * Lays out XML again: layout 'minified' (on one line) or the text for one level of indentation (each tag on its own
 * line, indented). Line breaks only go between two tags; text, attributes, comments, CDATA and the DOCTYPE are kept
 * exactly as written, and an element holding only text stays on one line. 'minified' removes only the spaces and line
 * breaks between tags that contain a line break (a file that was on one line has none of its own).
 */
function reflowXml(text, layout, base = '') {
  const spread = layout !== 'minified';
  const out = [];
  const pad = [];
  const newline = (depth) => (pad[depth] ??= '\n' + base + layout.repeat(Math.max(0, depth)));
  const until = (marker, from) => {
    const i = text.indexOf(marker, from);
    return i === -1 ? text.length : i + marker.length;
  };
  let depth = 0;
  let prev = null; // the last piece: 'open', 'close', 'other' (comment, declaration, empty element) or 'text'
  for (let i = 0; i < text.length;) {
    if (text[i] !== '<') {
      const stop = text.indexOf('<', i) === -1 ? text.length : text.indexOf('<', i);
      const run = text.slice(i, stop);
      i = stop;
      // Line breaks and spaces between two tags: layout, replaced by this layout's own
      if (prev !== null && prev !== 'text' && stop < text.length && !run.trim() && run.includes('\n')) continue;
      out.push(run);
      prev = 'text';
      continue;
    }
    let end;
    if (text.startsWith('<!--', i)) end = until('-->', i + 4);
    else if (text.startsWith('<![CDATA[', i)) end = until(']]>', i + 9);
    else if (text.startsWith('<?', i)) end = until('?>', i + 2);
    else if (text.startsWith('<!', i)) {
      // <!DOCTYPE ...>, with an internal subset in [ ] if it has one
      const gt = text.indexOf('>', i);
      const bracket = text.indexOf('[', i);
      end = bracket !== -1 && (gt === -1 || bracket < gt) ? until('>', until(']', bracket)) : until('>', i);
    } else {
      // A tag: up to its ">", skipping any inside quoted attribute values
      let j = i + 1;
      for (let quote = null; j < text.length; j++) {
        const ch = text[j];
        if (quote) { if (ch === quote) quote = null; } else if (ch === '"' || ch === "'") quote = ch; else if (ch === '>') break;
      }
      end = j + 1;
    }
    const piece = text.slice(i, end);
    i = end;
    if (piece.startsWith('<![CDATA[')) {
      // CDATA is the element's text: no line break may go around it
      out.push(piece);
      prev = 'text';
      continue;
    }
    const kind = piece.startsWith('</') ? 'close'
      : piece[1] === '!' || piece[1] === '?' || piece.endsWith('/>') ? 'other' : 'open';
    if (kind === 'close') depth--;
    // A new line before each tag that follows another tag (an empty element, <a></a>, stays on one line)
    if (spread && prev !== null && prev !== 'text' && !(kind === 'close' && prev === 'open')) out.push(newline(depth));
    out.push(piece);
    if (kind === 'open') depth++;
    prev = kind;
  }
  return out.join('');
}

/** True for text written on one line (minified), with at most a line break at the end. */
const isOneLine = (text) => {
  const i = text.indexOf('\n');
  return i === -1 || i === text.length - 1;
};

/** The length of a text's longest line. */
function longestLine(text) {
  let max = 0;
  for (let start = 0; ;) {
    const end = text.indexOf('\n', start);
    max = Math.max(max, (end === -1 ? text.length : end) - start);
    if (end === -1) return max;
    start = end + 1;
  }
}

/** The indentation unit of a file (spaces per level): the smallest indentation in its first lines. */
function indentUnit(text) {
  let unit = 0;
  for (const line of text.slice(0, 100000).split('\n', 300)) {
    const n = /^ */.exec(line)[0].length;
    if (n > 0 && n < line.length && (!unit || n < unit)) unit = n;
  }
  return unit || 2;
}

/**
 * Creates the code editor inside parent, with the same "surface" as the other editors (see editor.js).
 * setLanguage('json' | 'xml') picks the language before a file's text is set.
 * @param {{ onInput: () => void, title: () => string }} host title gives the file name
 */
export function createCodeSurface(parent, host) {
  const editable = new Compartment();
  const wrapSlot = new Compartment();
  let disabled = true;
  let kind = 'json';
  let unit = 2;
  // What the file's longest line allows: wrapping (see LONG_LINE); locked: some lines are read-only (EDIT_MAX_LINE);
  // oneLine: the whole file is one line (minified)
  let mode = { wrap: true, locked: false, oneLine: false };
  const modeFor = (text) => {
    const longest = longestLine(text);
    return { wrap: longest <= LONG_LINE, locked: longest > EDIT_MAX_LINE, oneLine: isOneLine(text) };
  };
  // Edits in a line over EDIT_MAX_LINE are dropped (Format, and Undo/Redo of it, may change them)
  const lockLongLines = EditorState.changeFilter.of((tr) => {
    if (!mode.locked || tr.isUserEvent('input.format') || tr.isUserEvent('undo') || tr.isUserEvent('redo')) return true;
    const blocked = [];
    tr.changes.iterChangedRanges((from, to) => {
      const doc = tr.startState.doc;
      for (let line = doc.lineAt(from); ; line = doc.line(line.number + 1)) {
        if (line.length > EDIT_MAX_LINE) blocked.push(line.from, line.to);
        if (line.to >= to || line.number === doc.lines) break;
      }
    });
    return blocked.length ? blocked : true;
  });

  // Our own element around the editor, for the classes editor.js sets (which surface is in use). It scrolls, with
  // the file name and summary bar above the editor, as in the Read view.
  const root = document.createElement('div');
  root.className = 'live-code-root';
  parent.append(root);

  const header = document.createElement('div');
  header.className = 'live-code-head';
  header.innerHTML = `
    <div class="inline-title"></div>
    <div class="viewer-bar">
      <span><span class="viewer-info"></span><span class="live-code-note"></span></span>
      <div class="viewer-actions">
        <button type="button" data-op="expand">Expand all</button>
        <button type="button" data-op="collapse">Collapse all</button>
        <button type="button" data-op="format" title="Spread the file over indented lines, to read and edit it. Values and text stay exactly as written; a file that was on one line (minified) is saved on one line again.">Format</button>
      </div>
    </div>`;
  const info = header.querySelector('.viewer-info');
  const setInfo = (text, error = false) => {
    info.textContent = text;
    info.classList.toggle('viewer-error', error);
  };
  header.querySelector('.viewer-actions').addEventListener('click', (e) => {
    const op = e.target.closest('button')?.dataset.op;
    if (op === 'collapse') collapseFrom(1, BUTTON_BUDGET_MS);
    else if (op === 'expand') unfoldAll(view);
    else if (op === 'format') format();
  });
  root.append(header);

  // JSON: checked as you type; the same check gives the summary ("Object · 12 keys")
  const jsonLinter = linter((v) => {
    try {
      const data = JSON.parse(v.state.doc.toString());
      setInfo(Array.isArray(data) ? `Array · ${data.length.toLocaleString()} items`
        : data && typeof data === 'object' ? `Object · ${Object.keys(data).length.toLocaleString()} keys`
          : 'Single value');
      return [];
    } catch (e) {
      setInfo(`Not valid JSON: ${e.message}`, true);
      return jsonParseLinter()(v);
    }
  }, { delay: 300 });

  // XML: the summary ("Root <products> · 120 elements") a moment after typing stops
  let xmlTimer = 0;
  function xmlInfo() {
    const text = view.state.doc.toString();
    const rootName = /<([A-Za-z_:][\w:.-]*)/.exec(text)?.[1];
    // Start tags: "<" followed by a name (not "</", "<?" or "<!"); counted without building a list of them
    let elements = 0;
    for (let i = text.indexOf('<'); i !== -1; i = text.indexOf('<', i + 1)) {
      if (/[A-Za-z_:]/.test(text[i + 1])) elements++;
    }
    setInfo(rootName ? `Root <${rootName}> · ${elements.toLocaleString()} elements` : 'No elements');
  }

  const tree = ViewPlugin.fromClass(class {
    constructor(view) { this.build(view); }
    update(u) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)
        || u.transactions.some((tr) => tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)))) {
        this.build(u.view);
      }
    }
    // Only for the lines on screen: indentation widened to the Read view's levels, guide lines, and the ▸
    build(view) {
      const { state } = view;
      const folded = foldedRanges(state);
      const widen = Decoration.mark({ attributes: { style: `letter-spacing: calc(${LEVEL_PX / unit}px - 1ch)` } });
      const ranges = [];
      const hidden = [];
      const done = new Set();
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to;) {
          const line = state.doc.lineAt(pos);
          pos = line.to + 1;
          if (done.has(line.number)) continue;
          done.add(line.number);
          if (line.length > LONG_LINE) {
            // Only its start, then how much is hidden
            hidden.push(Decoration.replace({ widget: new More(line.length - LONG_LINE_SHOWN) }).range(line.from + LONG_LINE_SHOWN, line.to));
          } else if (line.from < from) {
            continue; // the rest of a line after a collapsed branch
          }
          // Only the start of the line: a minified file is one line of millions of characters
          const spaces = /^ */.exec(state.sliceDoc(line.from, Math.min(line.to, line.from + 1000)))[0].length;
          const level = Math.floor(spaces / unit);
          if (level > 0) ranges.push(Decoration.line({ class: 'cm-tree-line', attributes: { style: `--level: ${level}` } }).range(line.from));
          if (spaces > 0) ranges.push(widen.range(line.from, line.from + spaces));
          let toggle = '';
          folded.between(line.from, line.to, () => { toggle = 'closed'; });
          if (!toggle && foldable(state, line.from, line.to)) toggle = 'open';
          ranges.push(Decoration.widget({ widget: new Toggle(toggle), side: -1 }).range(line.from + spaces));
        }
      }
      this.hidden = Decoration.set(hidden, true);
      this.decorations = Decoration.set([...ranges, ...hidden], true);
    }
  }, {
    decorations: (p) => p.decorations,
    // The cursor steps over the hidden part of a long line as one piece
    provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.hidden ?? Decoration.none),
    eventHandlers: {
      mousedown(e, view) {
        const el = e.target.closest?.('.cm-tree-toggle.open, .cm-tree-toggle.closed');
        if (!el) return false;
        e.preventDefault();
        const line = view.state.doc.lineAt(view.posAtDOM(el));
        if (el.classList.contains('closed')) {
          const effects = [];
          foldedRanges(view.state).between(line.from, line.to, (from, to) => { effects.push(unfoldEffect.of({ from, to })); });
          view.dispatch({ effects });
        } else {
          const range = foldable(view.state, line.from, line.to);
          if (range) view.dispatch({ effects: foldEffect.of(range) });
        }
        return true;
      },
    },
  });

  // A collapsed branch shows its size, as in the Read view
  const folding = codeFolding({
    preparePlaceholder(state, range) {
      let node = syntaxTree(state).resolveInner(range.from, -1);
      while (node && !KINDS[kind].isBranch(node)) node = node.parent;
      return node ? KINDS[kind].summary(node, state) : '…';
    },
    placeholderDOM(view, onclick, summary) {
      const el = document.createElement('span');
      el.className = 'cm-tree-summary';
      el.textContent = summary;
      el.onclick = onclick;
      return el;
    },
  });

  const extensions = () => [
    history(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    // Without CodeMirror's Ctrl+U (undo selection): Ctrl+U is the app's Source mode
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap.filter((b) => !/^Mod-(Shift-)?u$/.test(b.key)), ...foldKeymap, indentWithTab]),
    syntaxHighlighting(codeStyle),
    KINDS[kind].language(),
    lockLongLines,
    kind === 'json' ? jsonLinter : [],
    folding,
    tree,
    wrapSlot.of(mode.wrap ? EditorView.lineWrapping : []),
    editable.of(EditorView.editable.of(!disabled)),
    // CodeMirror manages its element's classes, so they're given here rather than added afterwards
    EditorView.editorAttributes.of({ class: 'live-editor live-code' }),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      host.onInput();
      // Undoing or redoing Format changes whether the file has long lines
      if (u.transactions.some((tr) => tr.isUserEvent('undo') || tr.isUserEvent('redo'))) {
        setTimeout(() => setMode(modeFor(view.state.doc.toString())));
      }
      if (kind === 'xml') {
        clearTimeout(xmlTimer);
        xmlTimer = setTimeout(xmlInfo, 400);
      }
    }),
  ];

  const view = new EditorView({ parent: root, state: EditorState.create({ doc: '', extensions: extensions() }) });
  let known = { text: '', doc: view.state.doc }; // a document known to equal a text (see differs)

  /** Shows what the file's longest line allows (see modeFor): the note about read-only lines. */
  function showMode(next) {
    root.classList.toggle('live-code-oneline', next.oneLine);
    header.querySelector('.live-code-note').textContent = !next.locked ? ''
      : next.oneLine ? ' · All on one line, so read-only here: Format to edit it'
        : ` · Lines over ${EDIT_MAX_LINE.toLocaleString()} characters are read-only here`;
  }

  /** Switches to what a new longest line allows (see modeFor), after Format or other changes to the layout. */
  function setMode(next) {
    showMode(next);
    const wrapChanged = next.wrap !== mode.wrap;
    mode = next;
    if (wrapChanged) view.dispatch({ effects: wrapSlot.reconfigure(next.wrap ? EditorView.lineWrapping : []) });
  }

  /**
   * Format: spreads the file over indented lines, as one edit (Undo reverts it). Only for a valid file. Only the
   * layout changes, so the formatted text still counts as the text it came from: no unsaved changes until you edit
   * it, and a file that was on one line is saved on one line again (see textForSave).
   */
  function format() {
    const before = view.state.doc;
    const text = before.toString();
    if (kind === 'xml' && !mode.oneLine) return; // see live.css: XML only when it's saved on one line again
    if (!KINDS[kind].valid(text)) return; // the summary (JSON) or Read mode (XML) says what's wrong
    const result = KINDS[kind].layout(text, '  ');
    if (result === text) return;
    const equivalent = before.eq(known.doc) ? known.text : text;
    unit = 2;
    view.dispatch({ changes: { from: 0, to: before.length, insert: result }, userEvent: 'input.format', scrollIntoView: false });
    known = { text: equivalent, doc: view.state.doc };
    setMode(modeFor(result));
    root.scrollTop = 0;
    host.onInput(); // the unsaved state, now that the formatted text counts as the file's
  }

  /** JSON: one branch (an object or array) on one line, or spread over lines, as one edit. */
  function layoutBranch(node, layout) {
    const { state } = view;
    const text = state.sliceDoc(node.from, node.to);
    const line = state.doc.lineAt(node.from);
    const base = /^ */.exec(state.sliceDoc(line.from, Math.min(line.to, line.from + 1000)))[0];
    const result = reflowJson(text, layout, base);
    if (result === text) return;
    view.dispatch({ changes: { from: node.from, to: node.to, insert: result }, userEvent: 'input.format' });
    setMode(modeFor(view.state.doc.toString())); // a branch on one line may make a line long
  }

  /** The JSON branch a right-click is about: the object or array clicked in, or a property's object/array value. */
  function branchAt(pos) {
    for (let node = syntaxTree(view.state).resolveInner(pos, 1); node; node = node.parent) {
      if (node.name === 'Property' && KINDS.json.isBranch(node.lastChild)) return node.lastChild;
      if (KINDS.json.isBranch(node)) return node;
    }
    return null;
  }

  // Right-click in JSON: a small menu to put the branch there on one line or spread it over lines
  let menu = null;
  const closeMenu = () => { menu?.remove(); menu = null; };
  addEventListener('pointerdown', (e) => { if (menu && !menu.contains(e.target)) closeMenu(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  addEventListener('wheel', closeMenu, { passive: true });
  root.addEventListener('contextmenu', (e) => {
    if (kind !== 'json' || !e.target.closest('.cm-content')) return;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    const node = pos == null ? null : branchAt(pos);
    if (!node) return;
    e.preventDefault();
    closeMenu();
    const what = `${node.name === 'Object' ? 'object' : 'array'} (${KINDS.json.summary(node)})`;
    const multiLine = view.state.doc.lineAt(node.from).number !== view.state.doc.lineAt(node.to).number;
    menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');
    for (const [label, layout, enabled] of [
      [`Put this ${what} on one line`, 'inline', multiLine],
      [`Spread this ${what} over lines`, '  ', !multiLine],
    ]) {
      const btn = document.createElement('button');
      btn.setAttribute('role', 'menuitem');
      btn.textContent = label;
      btn.disabled = !enabled;
      btn.onclick = () => { closeMenu(); layoutBranch(node, layout); view.focus(); };
      menu.append(btn);
    }
    document.body.append(menu);
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(e.clientX, innerWidth - width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(e.clientY, innerHeight - height - 4))}px`;
    menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  });

  /**
   * Collapses the branches from a level down (0 is the outermost), as the Read view shows them. False if reading the
   * file's structure took longer than budget (then nothing changes).
   */
  function collapseFrom(depth, budget) {
    const { state } = view;
    const parsed = ensureSyntaxTree(state, state.doc.length, budget);
    if (!parsed) return false;
    const { isBranch, range } = KINDS[kind];
    const effects = [];
    const visit = (node, d) => {
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (!isBranch(c)) {
          if (c.firstChild) visit(c, d); // e.g. a JSON property: the value in it is on the same level
        } else if (d < depth) {
          visit(c, d + 1);
        } else {
          const r = range(c);
          if (r.to > r.from && state.doc.lineAt(r.from).number !== state.doc.lineAt(r.to).number) effects.push(foldEffect.of(r));
        }
      }
    };
    visit(parsed.topNode, 0);
    unfoldAll(view);
    if (effects.length) view.dispatch({ effects });
    return true;
  }

  return {
    element: view.contentDOM,
    root,
    view,
    setLanguage(k) {
      if (!KINDS[k]) return;
      kind = k;
      root.classList.toggle('live-code-xml', k === 'xml');
    },
    get value() { return view.state.doc.toString(); },
    /** Replaces the whole text with a fresh document (and a fresh undo history), in the current language. */
    set value(text) {
      header.querySelector('.inline-title').textContent = host.title();
      setInfo('');
      unit = indentUnit(text);
      mode = modeFor(text);
      showMode(mode);
      view.setState(EditorState.create({ doc: text, extensions: extensions() }));
      known = { text, doc: view.state.doc };
      // The same levels open as in the Read view (when the file is quick to read; big files start expanded)
      if (text.length <= OPEN_FOLD_MAX && !mode.oneLine) collapseFrom(OPEN_DEPTH[kind], OPEN_BUDGET_MS);
      if (kind === 'xml') xmlInfo();
    },
    /**
     * True if the text differs from text, without building the whole text on every keystroke: edited documents share
     * their unchanged parts with the one they came from, so comparing with a known document is quick.
     */
    differs(text) {
      const { doc } = view.state;
      if (known.text === text && doc.eq(known.doc)) return false;
      if (doc.length !== text.length || doc.toString() !== text) return true;
      known = { text, doc };
      return false;
    },
    /**
     * The text to save. A file that was on one line (minified) is saved on one line again after Format: only the
     * layout changes, values and text stay exactly as written. saved: the file's text as last loaded or saved.
     */
    textForSave(saved) {
      const { doc } = view.state;
      if (doc.eq(known.doc)) return known.text;
      const text = doc.toString();
      if (!saved.trim() || !isOneLine(saved) || isOneLine(text) || !KINDS[kind].valid(text)) return text;
      const result = KINDS[kind].layout(text, 'minified');
      known = { text: result, doc };
      return result;
    },
    get selectionStart() { return view.state.selection.main.from; },
    get selectionEnd() { return view.state.selection.main.to; },
    setSelectionRange(start, end) {
      const len = view.state.doc.length;
      view.dispatch({ selection: { anchor: Math.min(start, len), head: Math.min(end, len) }, scrollIntoView: true });
    },
    replaceSelection(text) { view.dispatch({ ...view.state.replaceSelection(text), scrollIntoView: true, userEvent: 'input' }); },
    undo: () => undo(view),
    redo: () => redo(view),
    focus: () => view.focus(),
    get disabled() { return disabled; },
    set disabled(value) {
      disabled = value;
      view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!value)) });
    },
    get scrollTop() { return root.scrollTop; },
    set scrollTop(value) { root.scrollTop = value; },
    scrollBox: () => root,
    on: (type, fn) => view.contentDOM.addEventListener(type, fn),
  };
}
