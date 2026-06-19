import { isAbsolute, relative } from "pathe";

// True when `candidate` resolves to a location strictly inside `dir` — not `dir`
// itself, not an ancestor, and not an absolute path elsewhere. Both arguments
// should be absolute paths. pathe normalizes every path to `/`, so the check needs
// no platform-specific separator branching. Useful anywhere a path must be
// confined to a directory (e.g. refusing config references that escape it).
export function isPathInside(dir: string, candidate: string): boolean {
  const rel = relative(dir, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}
