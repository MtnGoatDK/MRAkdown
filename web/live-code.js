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
  },
  xml: {
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

/** The file name and summary bar above the text, as in the Read view; scrolls with the text. */
class Header extends WidgetType {
  constructor(el) { super(); this.el = el; }
  eq() { return true; }
  toDOM() { return this.el; }
  ignoreEvent() { return true; }
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
  let disabled = true;
  let kind = 'json';
  let unit = 2;

  // Our own element around the editor, for the classes editor.js sets (which surface is in use)
  const root = document.createElement('div');
  root.className = 'live-code-root';
  parent.append(root);

  const header = document.createElement('div');
  header.className = 'live-code-head';
  header.innerHTML = `
    <div class="inline-title"></div>
    <div class="viewer-bar">
      <span class="viewer-info"></span>
      <div class="viewer-actions">
        <button type="button" data-op="expand">Expand all</button>
        <button type="button" data-op="collapse">Collapse all</button>
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
  });
  const headerDecorations = Decoration.set([Decoration.widget({ widget: new Header(header), block: true, side: -1 }).range(0)]);

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
    constructor(view) { this.decorations = this.build(view); }
    update(u) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)
        || u.transactions.some((tr) => tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)))) {
        this.decorations = this.build(u.view);
      }
    }
    // Only for the lines on screen: indentation widened to the Read view's levels, guide lines, and the ▸
    build(view) {
      const { state } = view;
      const folded = foldedRanges(state);
      const widen = Decoration.mark({ attributes: { style: `letter-spacing: calc(${LEVEL_PX / unit}px - 1ch)` } });
      const ranges = [];
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to;) {
          const line = state.doc.lineAt(pos);
          pos = line.to + 1;
          if (line.from < from) continue; // the rest of a line after a collapsed branch
          const spaces = /^ */.exec(line.text)[0].length;
          const level = Math.floor(spaces / unit);
          if (level > 0) ranges.push(Decoration.line({ class: 'cm-tree-line', attributes: { style: `--level: ${level}` } }).range(line.from));
          if (spaces > 0) ranges.push(widen.range(line.from, line.from + spaces));
          let toggle = '';
          folded.between(line.from, line.to, () => { toggle = 'closed'; });
          if (!toggle && foldable(state, line.from, line.to)) toggle = 'open';
          ranges.push(Decoration.widget({ widget: new Toggle(toggle), side: -1 }).range(line.from + spaces));
        }
      }
      return Decoration.set(ranges, true);
    }
  }, {
    decorations: (p) => p.decorations,
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
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
    syntaxHighlighting(codeStyle),
    KINDS[kind].language(),
    kind === 'json' ? jsonLinter : [],
    folding,
    tree,
    EditorView.decorations.of(headerDecorations),
    EditorView.lineWrapping,
    editable.of(EditorView.editable.of(!disabled)),
    // CodeMirror manages its element's classes, so they're given here rather than added afterwards
    EditorView.editorAttributes.of({ class: 'live-editor live-code' }),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      host.onInput();
      if (kind === 'xml') {
        clearTimeout(xmlTimer);
        xmlTimer = setTimeout(xmlInfo, 400);
      }
    }),
  ];

  const view = new EditorView({ parent: root, state: EditorState.create({ doc: '', extensions: extensions() }) });
  let known = { text: '', doc: view.state.doc }; // a document known to equal a text (see differs)

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
      view.setState(EditorState.create({ doc: text, extensions: extensions() }));
      known = { text, doc: view.state.doc };
      // The same levels open as in the Read view (when the file is quick to read; big files start expanded)
      if (text.length <= OPEN_FOLD_MAX) collapseFrom(OPEN_DEPTH[kind], OPEN_BUDGET_MS);
      if (kind === 'xml') xmlInfo();
    },
    /**
     * True if the text differs from text, without building the whole text on every keystroke: edited documents share
     * their unchanged parts with the one they came from, so comparing with a known document is quick.
     */
    differs(text) {
      const { doc } = view.state;
      if (known.text === text) return !doc.eq(known.doc);
      if (doc.length !== text.length || doc.toString() !== text) return true;
      known = { text, doc };
      return false;
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
    get scrollTop() { return view.scrollDOM.scrollTop; },
    set scrollTop(value) { view.scrollDOM.scrollTop = value; },
    scrollBox: () => view.scrollDOM,
    on: (type, fn) => view.contentDOM.addEventListener(type, fn),
  };
}
