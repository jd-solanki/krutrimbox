import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnostics } from "../diagnostics";

// Loads the built-in Markdown prompts and templates that ship with the CLI
// package. Keeping the defaults as real Markdown files (instead of escaped
// TypeScript strings) makes them readable and reviewable; the build copies
// `src/assets` to `dist/assets` so they travel with the published package.

const moduleDir = dirname(fileURLToPath(import.meta.url));

// The assets sit beside the compiled bundle at `dist/assets`, but when the tests
// run against TypeScript source the same files live at `src/assets`. Probe both
// so loading works identically from the published package and from source.
const ASSET_DIR_CANDIDATES = [
  join(moduleDir, "assets"),
  join(moduleDir, "..", "..", "assets")
];

let cachedAssetsDir: string | undefined;

function resolveAssetsDir(): string {
  if (cachedAssetsDir) {
    return cachedAssetsDir;
  }

  const found = ASSET_DIR_CANDIDATES.find((candidate) => existsSync(candidate));

  if (!found) {
    throw diagnostics.KB_R0007();
  }

  cachedAssetsDir = found;
  return found;
}

// Reads one built-in asset by its path relative to the assets directory (e.g.
// `templates/pull-request-body.md`).
export async function loadBuiltInAsset(assetPath: string): Promise<string> {
  return readFile(join(resolveAssetsDir(), assetPath), "utf8");
}
