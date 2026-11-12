import { describe, expect, it } from "vite-plus/test";

import { projectScriptCwd, projectSubdirectory } from "./projectScripts.ts";

describe("projectSubdirectory", () => {
  it.each([
    ["/repo", "/repo/packages/api", "packages/api"],
    ["/repo/", "/repo/packages/api/", "packages/api"],
    ["C:\\repo", "C:\\repo\\packages\\api", "packages/api"],
    ["/repo", "/repo", ""],
    ["/repo", "/repository/api", ""],
    ["/private/repo", "/repo/api", ""],
    [undefined, "/repo/api", ""],
    [null, "/repo/api", ""],
  ])("%s + %s -> %j", (root, workspace, expected) => {
    expect(projectSubdirectory(root, workspace)).toBe(expected);
  });
});

describe("projectScriptCwd", () => {
  it.each([
    [{ cwd: "/repo/crates/mill", repositoryRoot: "/repo" }, null, "/repo/crates/mill"],
    [{ cwd: "/repo/crates/mill", repositoryRoot: "/repo" }, "/wt/a", "/wt/a/crates/mill"],
    [{ cwd: "/repo/crates/mill", repositoryRoot: "/repo" }, "/wt/a/", "/wt/a/crates/mill"],
    [{ cwd: "/repo", repositoryRoot: "/repo" }, "/wt/a", "/wt/a"],
    [{ cwd: "/repo/crates/mill" }, "/wt/a", "/wt/a"],
    [
      { cwd: "C:\\repo\\crates\\mill", repositoryRoot: "C:\\repo" },
      "D:\\wt\\a",
      "D:\\wt\\a\\crates\\mill",
    ],
  ])("%o in %s -> %s", (project, worktreePath, expected) => {
    expect(projectScriptCwd({ project, worktreePath })).toBe(expected);
  });
});
