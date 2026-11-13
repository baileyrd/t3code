import { crateDir, note, workspaceRoot } from "./cases.ts";

export const notTopLevel = "fatal: please run from the toplevel directory in non-cone mode";

/**
 * A sparse worktree of `mill`. `base` is the set `sparseCheckoutPatterns` writes: root files, the
 * crate and its dependencies whole, and every member's manifest and target file. `set` drops it.
 * `patterns` are what the agent added, by path from the root; `""` matches everything.
 */
export type Sparse = { base: boolean; patterns: Array<string> };

export const sparseStart = (): Sparse => ({ base: true, patterns: [] });

const held = ["crates/mill", ...note.dependencies.map((name) => `crates/${name}`)];

// As in git: a pattern with any `/` but a trailing one matches from the root, a bare name at any
// depth. Globs are not modelled.
const matches = (pattern: string, path: string) => {
  if (pattern === "") return true;
  if (!pattern.includes("/")) return `/${path}/`.includes(`/${pattern}/`);
  const anchored = pattern.replace(/^\//, "");
  return path === anchored || path.startsWith(`${anchored}/`);
};

export const sparseVisible = (path: string, sparse: Sparse) => {
  const inBase =
    !path.includes("/") ||
    /^crates\/[^/]+\/(Cargo\.toml|src\/lib\.rs)$/.test(path) ||
    held.some((dir) => path.startsWith(`${dir}/`));
  return (sparse.base && inBase) || sparse.patterns.some((pattern) => matches(pattern, path));
};

const toplevel = /"?(\$\(git rev-parse --show-toplevel\)|`git rev-parse --show-toplevel`)"?/g;

const resolveDir = (cwd: string, dir: string) => {
  const parts = dir.startsWith("/") ? [] : cwd.split("/").filter(Boolean);
  for (const part of dir.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
};

/**
 * What `run` does with a shell command, starting in the crate's folder on every call: `cd` and
 * `git -C` move it, and `git sparse-checkout add` or `set` change `sparse` only from the worktree
 * root, as non-cone git does. Returns null for a command that touches no sparse checkout.
 */
export const simulateRun = (command: string, sparse: Sparse): string | null => {
  let cwd = crateDir;
  let output: string | null = null;
  for (const segment of command.replace(toplevel, workspaceRoot).split(/&&|\|\|?|;|\n/)) {
    const words = segment.trim().replace(/["']/g, "").split(/\s+/).filter(Boolean);
    if (words[0] === "cd") {
      cwd = resolveDir(cwd, words[1] ?? workspaceRoot);
      continue;
    }
    if (words[0] !== "git") continue;
    let dir = cwd;
    let at = 1;
    while (words[at] === "-C") {
      dir = resolveDir(dir, words[at + 1] ?? ".");
      at += 2;
    }
    if (words[at] !== "sparse-checkout") continue;
    const subcommand = words[at + 1];
    output ??= "";
    if (subcommand === "disable") sparse.patterns.push("");
    if (subcommand === "list")
      output += [...(sparse.base ? held : []), ...sparse.patterns].join("\n") + "\n";
    if (subcommand !== "add" && subcommand !== "set") continue;
    if (dir !== workspaceRoot) return notTopLevel;
    // `./x` stays a pattern that matches nothing, as in git.
    const patterns = words
      .slice(at + 2)
      .filter((arg) => !arg.startsWith("-"))
      .map((arg) => arg.replace(/\/+$/, ""))
      .filter((pattern) => pattern !== "");
    if (subcommand === "set") {
      sparse.base = false;
      sparse.patterns.length = 0;
    }
    sparse.patterns.push(...patterns);
  }
  return output;
};
