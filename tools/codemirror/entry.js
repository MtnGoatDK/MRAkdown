// The parts of CodeMirror 6 that web/live.js and web/live-code.js use, bundled into web/codemirror.js (see package.json).
export { EditorState, EditorSelection, Compartment, StateField, RangeSetBuilder } from '@codemirror/state';
export {
  EditorView, Decoration, ViewPlugin, WidgetType, keymap, drawSelection,
  lineNumbers, highlightActiveLine, highlightActiveLineGutter,
} from '@codemirror/view';
export { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
export {
  syntaxTree, syntaxHighlighting, HighlightStyle, ensureSyntaxTree,
  bracketMatching, foldGutter, foldKeymap, indentOnInput,
  codeFolding, foldable, foldEffect, unfoldEffect, foldedRanges, unfoldAll,
} from '@codemirror/language';
export { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
export { linter, lintGutter } from '@codemirror/lint';
export { markdown, markdownLanguage } from '@codemirror/lang-markdown';
export { json, jsonParseLinter } from '@codemirror/lang-json';
export { xml } from '@codemirror/lang-xml';
export { tags } from '@lezer/highlight';
