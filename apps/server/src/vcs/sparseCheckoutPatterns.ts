/** Absolute paths a sparse checkout must hold: whole folders, and single files. */
export interface SparseCheckoutPaths {
  readonly directories: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
}

const isWindowsPath = (value: string) => /^[a-zA-Z]:|^[\\/]{2}/.test(value);
const slashes = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");
// gitignore syntax: these characters match patterns unless escaped.
const escapePattern = (value: string) => value.replace(/[\\*?[\]]/g, "\\$&");

/** `path` below `root`, `/`-separated with its own letter case; null outside it or at the root. */
function relativeTo(root: string, path: string): string | null {
  const base = slashes(root);
  const target = slashes(path);
  const fold = isWindowsPath(base)
    ? (value: string) => value.toLowerCase()
    : (value: string) => value;
  if (!fold(target).startsWith(`${fold(base)}/`)) return null;
  const relative = target.slice(base.length + 1);
  return relative
    .split("/")
    .some((segment) => segment === "" || segment === "." || segment === "..")
    ? null
    : relative;
}

/**
 * Non-cone sparse-checkout patterns for `paths`, in the shape cone mode writes: every file at the
 * repository root and `.cargo/`, the files directly inside each folder's ancestors (where nested
 * agent instructions live), the folders themselves, then single files. Paths outside the
 * repository are left out, since no checkout can hold them.
 */
export function sparseCheckoutPatterns(
  repoRoot: string,
  paths: SparseCheckoutPaths,
): ReadonlyArray<string> {
  const directories = paths.directories.flatMap((dir) => {
    const relative = relativeTo(repoRoot, dir);
    return relative === null ? [] : [relative];
  });
  const ancestors = new Set<string>();
  for (const dir of directories) {
    const segments = dir.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      ancestors.add(segments.slice(0, depth).join("/"));
    }
  }
  const byDepth = [...ancestors].sort(
    (left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right),
  );
  const files = paths.files.flatMap((file) => {
    const relative = relativeTo(repoRoot, file);
    return relative === null ? [] : [`/${escapePattern(relative)}`];
  });
  return [
    ...new Set([
      "/*",
      "!/*/",
      "/.cargo/",
      ...byDepth.flatMap((dir) => [`/${escapePattern(dir)}/*`, `!/${escapePattern(dir)}/*/`]),
      ...directories.map((dir) => `/${escapePattern(dir)}/`),
      ...files,
    ]),
  ];
}
