import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "pathe";
import { isPathInside } from "../../../utils/path";

// Safety boundary for files referenced from `.krutrimbox/config.json`. Such files
// must stay repository-owned even after symlinks are followed: a link inside the
// config directory may point at another file there, but never at a file elsewhere
// in the checkout or on the host. See ADR-0013.

export type RepoFileResolution =
  | { ok: true; realPath: string }
  | { ok: false; reason: "escapes" | "missing" };

// Resolves a config-relative path to an absolute file path, refusing anything that
// leaves `configDir`. Containment is checked twice — once as written, once after
// `realpathSync` follows every symlink — so neither `..` nor a symlink can escape.
export function resolveRepoOwnedFile(
  configuredPath: string,
  configDir: string
): RepoFileResolution {
  const resolved = resolve(configDir, configuredPath);
  if (!isPathInside(configDir, resolved)) {
    return { ok: false, reason: "escapes" };
  }

  if (!existsSync(resolved)) {
    return { ok: false, reason: "missing" };
  }

  const realPath = realpathSync(resolved);
  if (!isPathInside(realpathSync(configDir), realPath)) {
    return { ok: false, reason: "escapes" };
  }

  if (!statSync(realPath).isFile()) {
    return { ok: false, reason: "missing" };
  }

  return { ok: true, realPath };
}
