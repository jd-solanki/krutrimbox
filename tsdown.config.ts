import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node20",
  // Emit dist/index.js (not .mjs); the package is already "type": "module",
  // so the bin path stays a plain .js extension.
  fixedExtension: false,
  // Reads `version` from package.json via an import attribute; inline it so the
  // published bundle has no runtime dependency on the package.json location.
  shims: true,
  clean: true,
  // Ship the built-in Markdown prompts and templates beside the bundle so the
  // installed CLI loads the same defaults from `dist/assets` (ADR-0013).
  copy: [{ from: "src/assets", to: "dist/assets" }]
});
