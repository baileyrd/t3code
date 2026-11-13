import { crateDir, workspaceRoot } from "./cases.ts";

export const notTopLevel = "fatal: please run from the toplevel directory in non-cone mode";

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
 * What `run` does with a shell command in a sparse worktree, starting in the crate's folder: `cd`
 * and `git -C` move it, and `git sparse-checkout add` adds its patterns to `widened` only from the
 * worktree root, as non-cone git does. Returns null for a command that touches no sparse checkout.
 */
export const simulateRun = (command: string, widened: Array<string>): string | null => {
  let cwd = crateDir;
  let touched = false;
  for (const segment of command.replace(toplevel, workspaceRoot).split(/&&|\|\||;|\n/)) {
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
    touched = true;
    if (words[at + 1] === "disable") widened.push("");
    if (words[at + 1] !== "add") continue;
    if (dir !== workspaceRoot) return notTopLevel;
    // Patterns, not paths: a leading `/` anchors at the root, and `./x` matches nothing.
    for (const arg of words.slice(at + 2)) {
      const pattern = arg.replace(/^\/|\/+$/g, "");
      if (!arg.startsWith("-") && pattern !== "") widened.push(pattern);
    }
  }
  return touched ? "" : null;
};
