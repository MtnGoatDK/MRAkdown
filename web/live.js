// Live mode: edit the Markdown source while it looks rendered, like Obsidian's Live Preview. The text stays exactly
// what you type; formatting marks are only hidden, and show again on the lines the cursor is on.
// Loaded by editor.js the first time a pane switches to Live mode (with the bundled CodeMirror 6, codemirror.js).
import {
  EditorState, Compartment, StateField,
  EditorView, Decoration, ViewPlugin, WidgetType, keymap,
  defaultKeymap, history, historyKeymap, indentWithTab, undo, redo,
  syntaxTree, syntaxHighlighting, HighlightStyle,
  markdown, markdownLanguage, tags,
} from '/__app/codemirror.js';

const css = document.createElement('link');
css.rel = 'stylesheet';
css.href = '/__app/live.css';
document.head.append(css);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/* ---------- Which lines show their Markdown ---------- */

/** Line numbers the selection touches, while the editor has focus; there, the raw Markdown shows. */
function activeLines(state, focused) {
  const lines = new Set();
  if (!focused) return lines;
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number;
    const last = state.doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) lines.add(n);
  }
  return lines;
}

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

/** The range of a YAML front matter block at the start ("---" ... "---"), or null. */
function frontMatter(doc) {
  const m = doc.sliceString(0, Math.min(doc.length, 20000)).match(/^---[ \t]*\r?\n[\s\S]*?\n---[ \t]*(?=\r?\n|$)/);
  return m ? { from: 0, to: m[0].length } : null;
}

/* ---------- Widgets ---------- */

/** A bullet as the Read view draws it per level: disc, circle, square. */
class BulletWidget extends WidgetType {
  constructor(depth) { super(); this.depth = depth; }
  eq(other) { return other.depth === this.depth; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-lp-bullet';
    el.textContent = ['•', '◦', '▪'][(this.depth - 1) % 3];
    return el;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(checked) { super(); this.checked = checked; }
  eq(other) { return other.checked === this.checked; }
  toDOM(view) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-lp-checkbox';
    box.checked = this.checked;
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => {
      e.preventDefault();
      // The marker is "[ ]" or "[x]": toggle the character between the brackets.
      const pos = view.posAtDOM(box);
      const mark = view.state.sliceDoc(pos, pos + 3);
      if (!/^\[[ xX]\]$/.test(mark)) return;
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: this.checked ? ' ' : 'x' }, userEvent: 'input' });
    });
    return box;
  }
  ignoreEvent() { return true; }
}

class ImageWidget extends WidgetType {
  /** src: a URL, or a promise of one (wikilink embeds are resolved by the host). */
  constructor(src, alt, width) { super(); this.src = src; this.alt = alt; this.width = width; }
  eq(other) { return other.src === this.src && other.alt === this.alt && other.width === this.width; }
  toDOM() {
    const img = document.createElement('img');
    img.className = 'cm-lp-image';
    img.alt = this.alt;
    if (this.width) img.width = this.width;
    Promise.resolve(this.src).then((src) => { if (src) img.src = src; else img.classList.add('missing'); });
    return img;
  }
}

class TextWidget extends WidgetType {
  constructor(text, className) { super(); this.text = text; this.className = className; }
  eq(other) { return other.text === this.text && other.className === this.className; }
  toDOM() {
    const el = document.createElement('span');
    el.className = this.className;
    el.textContent = this.text;
    return el;
  }
}

/**
 * Front matter, shown as one small "Properties" line with its keys and values (Read mode doesn't show it); clicking
 * it puts the cursor in it, which shows the YAML.
 */
class PropertiesWidget extends WidgetType {
  constructor(source, from) { super(); this.source = source; this.from = from; }
  eq(other) { return other.source === this.source; }
  toDOM(view) {
    const el = document.createElement('div');
    el.className = 'cm-lp-props';
    const label = document.createElement('span');
    label.className = 'cm-lp-props-label';
    label.textContent = 'Properties';
    el.append(label);
    // Top-level "key: value" lines; values on lines of their own (lists) are left out of the summary
    const pairs = this.source.split('\n').slice(1, -1)
      .map((line) => line.match(/^([^\s:#][^:]*):\s*(.*)$/))
      .filter(Boolean)
      .map(([, key, value]) => (value ? `${key}: ${value}` : key));
    el.append(document.createTextNode(pairs.length ? pairs.join(' · ') : 'none'));
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from + 4 } });
      view.focus();
    });
    return el;
  }
  ignoreEvent() { return false; }
}

/** A GFM table shown as a table; clicking it puts the cursor in it, which shows its Markdown. */
class TableWidget extends WidgetType {
  constructor(source, from) { super(); this.source = source; this.from = from; }
  eq(other) { return other.source === this.source; }
  toDOM(view) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-lp-table';
    wrap.innerHTML = tableHtml(this.source);
    wrap.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent() { return true; }
}

function splitRow(line) {
  const cells = [];
  let cell = '';
  const text = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '|') { cell += '|'; i++; } else if (text[i] === '|') { cells.push(cell.trim()); cell = ''; } else cell += text[i];
  }
  cells.push(cell.trim());
  return cells;
}

/** Bold, italic, code, strikethrough, highlights and links inside a table cell (as text). */
function inlineHtml(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, '<strong>$1$2</strong>')
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/==(.+?)==/g, '<mark>$1</mark>')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<span class="cm-lp-link">$2</span>')
    .replace(/\[\[([^\]]+)\]\]/g, '<span class="cm-lp-link">$1</span>')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '<span class="cm-lp-link">$1</span>');
}

function tableHtml(source) {
  const lines = source.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return esc(source);
  const align = splitRow(lines[1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : ''));
  const cell = (tag, text, i) => `<${tag}${align[i] ? ` style="text-align:${align[i]}"` : ''}>${inlineHtml(text)}</${tag}>`;
  const head = splitRow(lines[0]).map((c, i) => cell('th', c, i)).join('');
  const body = lines.slice(2).map((l) => `<tr>${splitRow(l).map((c, i) => cell('td', c, i)).join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/* ---------- Building the decorations ---------- */

const hide = Decoration.replace({});
const lineClass = (cls) => Decoration.line({ class: cls });

const WIKILINK = /(!?)\[\[([^\]\n]+?)\]\]/g;
const HIGHLIGHT = /==(?=\S)(.+?)(?<=\S)==/g;
const CALLOUT = /^(\s*>\s*)\[!([\w-]+)\]([+-]?)[ \t]*(.*)$/;
const CODE_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText', 'HTMLBlock', 'Comment']);

/** Line and inline decorations for the visible part of the document. */
function buildDecorations(view, host) {
  const { state } = view;
  const doc = state.doc;
  const active = activeLines(state, view.hasFocus);
  const isActive = (pos) => active.has(doc.lineAt(pos).number);
  const fm = frontMatter(doc);
  const ranges = [];
  const add = (from, to, deco) => { if (from <= to) ranges.push(deco.range(from, to)); };
  const addLine = (pos, cls) => ranges.push(lineClass(cls).range(doc.lineAt(pos).from));
  /** Hides a marker, and the spaces after it if hideSpace (e.g. "# " or "> "). */
  const hideMark = (from, to, hideSpace = false) => {
    let end = to;
    if (hideSpace) while (end < doc.lineAt(from).to && doc.sliceString(end, end + 1) === ' ') end++;
    add(from, end, hide);
  };

  if (fm) {
    for (let pos = fm.from; pos <= fm.to; pos = doc.lineAt(pos).to + 1) {
      addLine(pos, 'cm-lp-frontmatter');
      if (doc.lineAt(pos).to >= fm.to) break;
    }
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter(node) {
        const name = node.name;
        if (fm && node.from < fm.to) return name === 'Document';

        const heading = name.match(/^(?:ATXHeading|SetextHeading)(\d)$/);
        if (heading) {
          addLine(node.from, `cm-lp-h${heading[1]}`);
          return;
        }
        if (name === 'HeaderMark') {
          const parent = node.node.parent?.name ?? '';
          if (parent.startsWith('SetextHeading')) {
            if (!isActive(node.from)) add(node.from, node.to, hide);
          } else if (!isActive(node.from)) {
            hideMark(node.from, node.to, true);
          }
          return;
        }
        if (name === 'EmphasisMark' || name === 'StrikethroughMark') {
          if (!isActive(node.from)) hideMark(node.from, node.to);
          return;
        }
        if (name === 'InlineCode') {
          add(node.from, node.to, Decoration.mark({ class: 'cm-lp-inline-code' }));
          if (!isActive(node.from)) {
            for (let c = node.node.firstChild; c; c = c.nextSibling) if (c.name === 'CodeMark') hideMark(c.from, c.to);
          }
          return false;
        }
        if (name === 'FencedCode' || name === 'CodeBlock') {
          // Code blocks: monospaced lines; the ``` fence lines fade unless the cursor is in the block.
          const inside = [...active].some((n) => n >= doc.lineAt(node.from).number && n <= doc.lineAt(node.to).number);
          for (let pos = node.from; pos <= node.to; pos = doc.lineAt(pos).to + 1) {
            const line = doc.lineAt(pos);
            const isFence = name === 'FencedCode' && (line.from === doc.lineAt(node.from).from || line.to === doc.lineAt(node.to).to);
            addLine(pos, isFence ? (inside ? 'cm-lp-code cm-lp-fence-open' : 'cm-lp-code cm-lp-fence') : 'cm-lp-code');
            if (line.to >= node.to) break;
          }
          return false;
        }
        if (name === 'Link' || name === 'Image') {
          linkOrImage(node, name);
          return false;
        }
        if (name === 'URL' && node.node.parent?.name !== 'Link' && node.node.parent?.name !== 'Image') {
          // A bare web address (GFM autolink)
          const url = doc.sliceString(node.from, node.to);
          add(node.from, node.to, Decoration.mark({ class: 'cm-lp-link', attributes: isActive(node.from) ? {} : { 'data-href': url } }));
          return;
        }
        if (name === 'Blockquote') {
          blockquote(node);
          return;
        }
        if (name === 'ListMark') {
          // Laid out as the Read view's lists: each level indented 1.6em, the bullet or number in that space
          const listItem = node.node.parent;
          const isTask = listItem?.getChild('Task');
          const line = doc.lineAt(node.from);
          let depth = 0;
          for (let n = listItem?.parent; n; n = n.parent) if (n.name === 'BulletList' || n.name === 'OrderedList') depth++;
          if (node.from >= line.from && node.from - line.from <= 40) {
            ranges.push(Decoration.line({ class: isTask ? 'cm-lp-li cm-lp-task' : 'cm-lp-li', attributes: { style: `--depth: ${depth}` } }).range(line.from));
          }
          if (isActive(node.from)) return;
          if (node.from > line.from) add(line.from, node.from, hide); // the indentation: the line's padding shows it
          if (isTask) hideMark(node.from, node.to, true);
          else if (listItem?.parent?.name === 'BulletList') {
            add(node.from, node.to, Decoration.replace({ widget: new BulletWidget(depth) }));
            if (doc.sliceString(node.to, node.to + 1) === ' ') hideMark(node.to, node.to, true);
          } else {
            add(node.from, node.to, Decoration.mark({ class: 'cm-lp-ol' }));
            if (doc.sliceString(node.to, node.to + 1) === ' ') hideMark(node.to, node.to, true);
          }
          return;
        }
        if (name === 'TaskMarker') {
          if (!isActive(node.from)) {
            const checked = /x/i.test(doc.sliceString(node.from, node.to));
            add(node.from, node.to, Decoration.replace({ widget: new CheckboxWidget(checked) }));
          }
          return;
        }
        if (name === 'HorizontalRule') {
          if (!isActive(node.from)) {
            addLine(node.from, 'cm-lp-hr');
            add(node.from, node.to, hide);
          }
          return;
        }
        if (name === 'Table') return false; // shown by the table field below
        return undefined;
      },
    });

    // Wikilinks, embeds and ==highlights== aren't in CommonMark/GFM: find them in the text, outside code.
    for (let pos = from; pos <= to;) {
      const line = doc.lineAt(pos);
      if (!(fm && line.from < fm.to)) {
        inlineExtras(line);
        // A blank line between blocks is the Read view's space between paragraphs, not a whole line
        if (!line.text.trim() && !inCode(line.from)) addLine(line.from, 'cm-lp-blank');
      }
      pos = line.to + 1;
    }
  }

  function linkOrImage(node, name) {
    const marks = node.node.getChildren('LinkMark');
    const urlNode = node.node.getChild('URL');
    const url = urlNode ? doc.sliceString(urlNode.from, urlNode.to) : null;
    // Reference-style links ([text][ref]) are left as written.
    if (!url || marks.length < 2) return;
    if (isActive(node.from)) {
      if (name === 'Link') add(marks[0].to, marks[1].from, Decoration.mark({ class: 'cm-lp-link' }));
      return;
    }
    if (name === 'Image') {
      const alt = doc.sliceString(marks[0].to, marks[1].from);
      add(node.from, node.to, Decoration.replace({ widget: new ImageWidget(host.fileUrl(url), alt) }));
      return;
    }
    add(node.from, marks[0].to, hide);
    add(marks[0].to, marks[1].from, Decoration.mark({ class: 'cm-lp-link', attributes: { 'data-href': url } }));
    add(marks[1].from, node.to, hide);
  }

  function blockquote(node) {
    const first = doc.lineAt(node.from);
    const callout = first.text.match(CALLOUT);
    const color = callout ? host.calloutColor(callout[2].toLowerCase()) : null;
    for (let pos = node.from; pos <= node.to; pos = doc.lineAt(pos).to + 1) {
      const line = doc.lineAt(pos);
      if (callout) {
        ranges.push(Decoration.line({
          class: line.number === first.number ? 'cm-lp-callout cm-lp-callout-title' : 'cm-lp-callout',
          attributes: { style: `--c:${color}` },
        }).range(line.from));
      } else {
        addLine(line.from, 'cm-lp-quote');
      }
      if (!active.has(line.number)) {
        const mark = line.text.match(/^\s*>\s?/);
        if (mark) add(line.from, line.from + mark[0].length, hide);
        if (callout && line.number === first.number) {
          // "[!note] Title": hide the type marker; without a title, show the type's name instead.
          const markerFrom = line.from + callout[1].length;
          const markerTo = line.to - callout[4].length;
          if (callout[4]) add(markerFrom, markerTo, hide);
          else add(markerFrom, markerTo, Decoration.replace({ widget: new TextWidget(callout[2][0].toUpperCase() + callout[2].slice(1), 'cm-lp-callout-name') }));
        }
      }
      if (line.to >= node.to) break;
    }
  }

  function inCode(pos) {
    for (let n = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) if (CODE_NODES.has(n.name)) return true;
    return false;
  }

  function inlineExtras(line) {
    const lineActive = active.has(line.number);
    for (const m of line.text.matchAll(WIKILINK)) {
      const from = line.from + m.index;
      const to = from + m[0].length;
      if (inCode(from)) continue;
      const [target, alias] = m[2].split('|');
      if (m[1] === '!' && !lineActive && /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(target.trim())) {
        const width = /^\d+$/.test(alias ?? '') ? Number(alias) : undefined;
        add(from, to, Decoration.replace({ widget: new ImageWidget(host.resolveWikilink(target.trim()), target, width) }));
        continue;
      }
      if (lineActive) {
        add(from, to, Decoration.mark({ class: 'cm-lp-link cm-lp-wikilink' }));
        continue;
      }
      // Show the alias, or else the target; hide the brackets.
      const shownFrom = alias !== undefined ? from + m[1].length + 2 + target.length + 1 : from + m[1].length + 2;
      add(from, shownFrom, hide);
      add(shownFrom, to - 2, Decoration.mark({ class: 'cm-lp-link cm-lp-wikilink', attributes: { 'data-wiki': target.trim() } }));
      add(to - 2, to, hide);
    }
    for (const m of line.text.matchAll(HIGHLIGHT)) {
      const from = line.from + m.index;
      const to = from + m[0].length;
      if (inCode(from)) continue;
      add(from, to, Decoration.mark({ class: 'cm-lp-highlight' }));
      if (!lineActive) {
        add(from, from + 2, hide);
        add(to - 2, to, hide);
      }
    }
  }

  return Decoration.set(ranges, true);
}

/**
 * Tables and the front matter are block widgets, which CodeMirror only accepts from a state field (not a view
 * plugin). Each shows its Markdown (YAML) while the cursor is in it. allowed() is false for files with very long
 * lines: CodeMirror fails to lay out a block widget together with a wrapped line of millions of characters.
 */
function blockField(allowed) {
  const build = (state) => {
    const ranges = [];
    if (!allowed()) return Decoration.none;
    const active = activeLines(state, true);
    const fm = frontMatter(state.doc);
    if (fm) {
      const last = state.doc.lineAt(fm.to);
      if (![...active].some((n) => n <= last.number)) {
        const source = state.doc.sliceString(fm.from, fm.to);
        ranges.push(Decoration.replace({ widget: new PropertiesWidget(source, fm.from), block: true }).range(fm.from, fm.to));
      }
    }
    for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
      if (node.name !== 'Table' || (fm && node.from < fm.to)) continue;
      const first = state.doc.lineAt(node.from);
      const last = state.doc.lineAt(node.to);
      if ([...active].some((n) => n >= first.number && n <= last.number)) continue;
      const source = state.doc.sliceString(first.from, last.to);
      ranges.push(Decoration.replace({ widget: new TableWidget(source, first.from), block: true }).range(first.from, last.to));
    }
    return Decoration.set(ranges);
  };
  return StateField.define({
    create: build,
    update: (value, tr) => (tr.docChanged || tr.selection || tr.effects.length || syntaxTree(tr.state) !== syntaxTree(tr.startState) ? build(tr.state) : value),
    provide: (f) => EditorView.decorations.from(f),
  });
}

/* ---------- Styling of the Markdown tokens (also on lines that show their Markdown) ---------- */

const markdownStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--accent)' },
  { tag: tags.url, color: 'var(--faint)' },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.meta], color: 'var(--faint)' },
  { tag: tags.quote, color: 'var(--muted)' },
  { tag: tags.monospace, fontFamily: '"Cascadia Code", Consolas, monospace', fontSize: '0.9em' },
]);

/* ---------- The editor ---------- */

/**
 * Creates the Live editor inside parent. It offers the same "surface" as the plain editor (see editor.js), so the
 * formatting toolbar, saving and tabs work the same in both.
 * @param {{ onInput: () => void, openLink: (link: { href?: string, wiki?: string }, e: MouseEvent) => void,
 *           fileUrl: (url: string) => string, resolveWikilink: (target: string) => Promise<string|null>,
 *           calloutColor: (type: string) => string }} host
 */
export function createLiveSurface(parent, host) {
  const editable = new Compartment();
  const handlers = []; // [type, fn] registered with on(), kept across documents

  const livePreview = ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = buildDecorations(view, host); }
    update(update) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged
        || syntaxTree(update.state) !== syntaxTree(update.startState)) {
        this.decorations = buildDecorations(update.view, host);
      }
    }
  }, { decorations: (v) => v.decorations });

  const extensions = () => [
    history(),
    // Without CodeMirror's Ctrl+U (undo selection): Ctrl+U is the app's Source mode
    keymap.of([...defaultKeymap, ...historyKeymap.filter((b) => !/^Mod-(Shift-)?u$/.test(b.key)), indentWithTab]),
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(markdownStyle),
    EditorView.lineWrapping,
    editable.of(EditorView.editable.of(!disabled)),
    blockField(() => blockWidgets),
    livePreview,
    // CodeMirror manages its element's classes, so they're given here rather than added afterwards
    EditorView.editorAttributes.of({ class: 'live-editor' }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) host.onInput();
    }),
    EditorView.domEventHandlers({
      // A rendered link opens on click (with the same modifier keys as elsewhere); to edit it, use the keyboard or
      // click next to it on its line.
      mousedown(e) {
        const link = e.target.closest?.('[data-href], [data-wiki]');
        if (!link || (e.button !== 0 && e.button !== 1)) return false;
        e.preventDefault();
        host.openLink({ href: link.dataset.href, wiki: link.dataset.wiki }, e);
        return true;
      },
    }),
  ];

  let disabled = true;
  let blockWidgets = true; // see blockField
  // Our own element around the editor, for the classes editor.js sets (which surface is in use). It scrolls, with
  // the note's title above the text, as in the Read view.
  const root = document.createElement('div');
  root.className = 'live-md-root';
  parent.append(root);
  const head = document.createElement('div');
  head.className = 'live-md-head';
  head.innerHTML = '<div class="inline-title"></div>';
  root.append(head);
  const view = new EditorView({ parent: root, state: EditorState.create({ doc: '', extensions: extensions() }) });
  let known = { text: '', doc: view.state.doc }; // a document known to equal a text (see differs)

  const surface = {
    element: view.contentDOM,
    root,
    view,
    scrollBox: () => root,
    get value() { return view.state.doc.toString(); },
    /** Replaces the whole text with a fresh document (and a fresh undo history). */
    set value(text) {
      const title = host.title?.() ?? '';
      head.querySelector('.inline-title').textContent = title;
      head.hidden = !title;
      blockWidgets = longestLine(text) <= 10_000;
      view.setState(EditorState.create({ doc: text, extensions: extensions() }));
      known = { text, doc: view.state.doc };
    },
    /** True if the text differs from text; quick on big files (see the same in live-code.js). */
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
      // The start of a note with front matter: just after it, so the front matter stays a Properties line
      const fm = start === 0 && end === 0 ? frontMatter(view.state.doc) : null;
      if (fm) start = end = Math.min(fm.to + 1, len);
      view.dispatch({ selection: { anchor: Math.min(start, len), head: Math.min(end, len) }, scrollIntoView: true });
    },
    replaceSelection(text) {
      view.dispatch({ ...view.state.replaceSelection(text), scrollIntoView: true, userEvent: 'input' });
    },
    undo: () => undo(view),
    redo: () => redo(view),
    /** Applies text changes [{ from, to, insert }] (in order, offsets in the current text), keeping the cursor. */
    applyChanges: (changes) => view.dispatch({ changes }),
    focus: () => view.focus(),
    get disabled() { return disabled; },
    set disabled(value) {
      disabled = value;
      view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!value)) });
    },
    get scrollTop() { return root.scrollTop; },
    set scrollTop(value) { root.scrollTop = value; },
    /**
     * Listens for keydown, paste, dragover or drop before CodeMirror does; a handler that calls preventDefault
     * keeps the event from CodeMirror (e.g. pasting an image, or Ctrl+B).
     */
    on(type, fn) {
      handlers.push([type, fn]);
      view.contentDOM.addEventListener(type, (e) => {
        fn(e);
        if (e.defaultPrevented) e.stopImmediatePropagation();
      }, { capture: true });
    },
  };
  return surface;
}
