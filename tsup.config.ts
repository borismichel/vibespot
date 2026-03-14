import { defineConfig } from "tsup";

export default defineConfig([
  // Main server bundle
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node18",
    outDir: "dist",
    clean: true,
    splitting: false,
    sourcemap: true,
    dts: false,
    shims: true,
    minify: true,
  },
  // CodeMirror browser bundle (IIFE for <script> tag)
  {
    entry: ["src/editor/codemirror-bundle.ts"],
    outDir: "ui/vendor",
    format: ["iife"],
    globalName: "CM",
    platform: "browser",
    noExternal: [/.*/],
    splitting: false,
    sourcemap: false,
    dts: false,
    shims: false,
    minify: true,
    clean: false,
  },
]);
