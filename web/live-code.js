// Live mode for JSON and XML files: a code editor with syntax colours, line numbers, matching brackets, folding and
// (for JSON) syntax errors marked as you type. Loaded by editor.js the first time a pane needs it.
import {
  EditorState, Compartment,
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  defaultKeymap, history, historyKeymap, indentWithTab, undo, redo,
  syntaxHighlighting, HighlightStyle, bracketMatching, foldGutter, foldKeymap, indentOnInput,
  closeBrackets, closeBracketsKeymap, linter, lintGutter,
  json, jsonParseLinter, xml, tags,
} from '/__app/codemirror.js';

const css = document.createElement('link');
css.rel = 'stylesheet';
css.href = '/__app/live.css';
document.head.append(css);

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

const LANGUAGES = {
  json: () => [json(), linter(jsonParseLinter(), { delay: 300 })],
  xml: () => [xml()],
};

/**
 * Creates the code editor inside parent, with the same "surface" as the other editors (see editor.js).
 * setLanguage('json' | 'xml') picks the language before a file's text is set.
 * @param {{ onInput: () => void }} host
 */
export function createCodeSurface(parent, host) {
  const editable = new Compartment();
  let disabled = true;
  let language = 'json';

  const extensions = () => [
    lineNumbers(),
    highlightActiveLineGutter(),
    foldGutter(),
    lintGutter(),
    history(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
    syntaxHighlighting(codeStyle),
    LANGUAGES[language](),
    editable.of(EditorView.editable.of(!disabled)),
    // CodeMirror manages its element's classes, so they're given here rather than added afterwards
    EditorView.editorAttributes.of({ class: 'live-editor live-code' }),
    EditorView.updateListener.of((u) => { if (u.docChanged) host.onInput(); }),
  ];

  // Our own element around the editor, for the classes editor.js sets (which surface is in use)
  const root = document.createElement('div');
  parent.append(root);
  const view = new EditorView({ parent: root, state: EditorState.create({ doc: '', extensions: extensions() }) });
  let known = { text: '', doc: view.state.doc }; // a document known to equal a text (see differs)

  return {
    element: view.contentDOM,
    root,
    view,
    setLanguage(kind) { if (LANGUAGES[kind]) language = kind; },
    get value() { return view.state.doc.toString(); },
    /** Replaces the whole text with a fresh document (and a fresh undo history), in the current language. */
    set value(text) {
      view.setState(EditorState.create({ doc: text, extensions: extensions() }));
      known = { text, doc: view.state.doc };
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
