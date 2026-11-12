/** Absolute paths a sparse checkout must hold: whole folders, the project's first, and single files. */
export interface SparseCheckoutPaths {
  readonly directories: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
}

const isWindowsPath = (value: string) => /^[a-zA-Z]:|^[\\/]{2}/.test(value);
const slashes = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");
// gitignore syntax: these characters match patterns unless escaped.
const escapePattern = (value: string) => value.replace(/[\\*?[\]]/g, "\\$&");

/** `path` below `root`, `/`-separated with its own letter case; null outside it or at the root. */
export function relativeTo(root: string, path: string): string | null {
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
 * Cone-shaped non-cone patterns: root files, each ancestor's files and `.cargo/`, the folders, then
 * single files. Paths outside the repository are dropped; null when the project's own folder is,
 * since `repoRoot` and the paths then spell the root differently.
 */
export function sparseCheckoutPatterns(
  repoRoot: string,
  paths: SparseCheckoutPaths,
): ReadonlyArray<string> | null {
  const project = paths.directories[0];
  if (project === undefined || relativeTo(repoRoot, project) === null) return null;
  const directories = paths.directories.flatMap((dir) => {
    const relative = relativeTo(repoRoot, dir);
    return relative === null ? [] : [relative];
  });
  // A folder held whole is no ancestor: its `!dir/*/` would cut out its own subfolders.
  const whole = new Set(directories);
  const ancestors = new Set<string>();
  for (const dir of directories) {
    const segments = dir.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      const ancestor = segments.slice(0, depth).join("/");
      if (whole.has(ancestor)) break;
      ancestors.add(ancestor);
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
      ...byDepth.flatMap((dir) => [
        `/${escapePattern(dir)}/*`,
        `!/${escapePattern(dir)}/*/`,
        `/${escapePattern(dir)}/.cargo/`,
      ]),
      ...directories.map((dir) => `/${escapePattern(dir)}/`),
      ...files,
    ]),
  ];
}
