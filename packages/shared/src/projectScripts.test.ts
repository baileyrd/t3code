import { describe, expect, it } from "vite-plus/test";

import { projectScriptCwd, projectSubdirectory } from "./projectScripts.ts";

describe("projectSubdirectory", () => {
  it.each([
    ["/repo", "/repo/packages/api", "packages/api"],
    ["/repo/", "/repo/packages/api/", "packages/api"],
    ["C:\\repo", "C:\\repo\\packages\\api", "packages/api"],
    ["C:/repo", "C:\\repo\\packages\\api", "packages/api"],
    ["C:/Users/n/Repo", "c:\\users\\n\\repo\\api", "api"],
    ["/Users/n/Repo", "/Users/n/repo/api", ""],
    ["/repo", "/repo/../x", ""],
    ["/repo", "/repo/./api", ""],
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
    [
      { cwd: "/repo/crates/mill", repositorySubdirectory: "crates/mill" },
      null,
      "/repo/crates/mill",
    ],
    [
      { cwd: "/repo/crates/mill", repositorySubdirectory: "crates/mill" },
      "/wt/a",
      "/wt/a/crates/mill",
    ],
    [
      { cwd: "/repo/crates/mill", repositorySubdirectory: "crates/mill" },
      "/wt/a/",
      "/wt/a/crates/mill",
    ],
    [{ cwd: "/repo", repositorySubdirectory: "" }, "/wt/a", "/wt/a"],
    [{ cwd: "/repo/crates/mill", repositorySubdirectory: null }, "/wt/a", "/wt/a"],
    [{ cwd: "/repo/crates/mill" }, "/wt/a", "/wt/a"],
    [
      { cwd: "C:\\repo\\crates\\mill", repositorySubdirectory: "crates/mill" },
      "D:\\wt\\a",
      "D:\\wt\\a\\crates\\mill",
    ],
  ])("%o in %s -> %s", (project, worktreePath, expected) => {
    expect(projectScriptCwd({ project, worktreePath })).toBe(expected);
  });
});
