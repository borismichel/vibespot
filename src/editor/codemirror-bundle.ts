/**
 * CodeMirror 6 browser bundle — compiled by tsup into ui/vendor/codemirror-bundle.js.
 * Exports become properties on the window.CM global via tsup's globalName.
 */

export { EditorView, basicSetup } from "codemirror";
export { EditorState, Compartment } from "@codemirror/state";
export { html } from "@codemirror/lang-html";
export { css } from "@codemirror/lang-css";
export { javascript } from "@codemirror/lang-javascript";
export { json } from "@codemirror/lang-json";
export { oneDark } from "@codemirror/theme-one-dark";
export { keymap } from "@codemirror/view";
export {
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
export { tags } from "@lezer/highlight";
