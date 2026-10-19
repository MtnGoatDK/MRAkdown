// The parts of CodeMirror 6 that web/live.js uses, bundled into web/codemirror.js (see package.json).
export { EditorState, EditorSelection, Compartment, StateField, RangeSetBuilder } from '@codemirror/state';
export { EditorView, Decoration, ViewPlugin, WidgetType, keymap, drawSelection } from '@codemirror/view';
export { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
export { syntaxTree, syntaxHighlighting, HighlightStyle, ensureSyntaxTree } from '@codemirror/language';
export { markdown, markdownLanguage } from '@codemirror/lang-markdown';
export { tags } from '@lezer/highlight';
