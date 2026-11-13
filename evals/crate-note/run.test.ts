import { describe, expect, it } from "vite-plus/test";
import { sparseVisible, workspaceRoot } from "./cases.ts";
import { grade, type ToolCall } from "./grade.ts";
import { notTopLevel, simulateRun } from "./sandbox.ts";

const crateDir = "/w/crates/mill";
const dependencyDirs = ["/w/crates/rustils"];
const read = (path: string, found = true): ToolCall => ({ tool: "read_file", path, found });
const target = "/w/crates/telemetry/src/metrics.rs";

describe("grade", () => {
  it.each([
    [
      "dependency, straight to it",
      "dependency",
      [read(`${crateDir}/src/retry.rs`), read("/w/crates/rustils/src/backoff.rs")],
      true,
    ],
    [
      "dependency, workspace-wide search first",
      "dependency",
      [
        { tool: "search", path: "/w", pattern: "backoff" },
        read("/w/crates/rustils/src/backoff.rs"),
      ],
      false,
    ],
    [
      "dependency, cargo tree",
      "dependency",
      [{ tool: "run", command: "cargo tree -p mill" }, read("/w/crates/rustils/src/backoff.rs")],
      false,
    ],
    ["dependency, never left", "dependency", [read(`${crateDir}/src/retry.rs`)], false],
    ["local, stayed", "local", [read(`${crateDir}/src/retry.rs`)], true],
    [
      "local, wandered",
      "local",
      [read(`${crateDir}/src/retry.rs`), read("/w/crates/rustils/src/lib.rs")],
      false,
    ],
  ] as const)("%s", (_name, kind, calls, pass) => {
    expect(grade({ kind, calls, crateDir, dependencyDirs }).pass).toBe(pass);
  });

  it.each([
    ["widened, then read it", [read(target, false), read(target)], true],
    ["never got it in", [read(target, false)], false],
    ["read only another crate", [read("/w/crates/store/src/lib.rs")], false],
    [
      "disabled the sparse checkout",
      [{ tool: "run", command: "git sparse-checkout disable" }, read(target)],
      false,
    ],
  ] as const)("outside, %s", (_name, calls, pass) => {
    expect(grade({ kind: "outside", target, calls, crateDir, dependencyDirs }).pass).toBe(pass);
  });
});

describe("sparseVisible", () => {
  it.each([
    ["the crate", "crates/mill/src/retry.rs", [], true],
    ["a dependency", "crates/rustils/src/backoff.rs", [], true],
    ["another crate's target file", "crates/telemetry/src/lib.rs", [], true],
    ["another crate's module", "crates/telemetry/src/metrics.rs", [], false],
    ["it once added", "crates/telemetry/src/metrics.rs", ["crates/telemetry"], true],
    ["it once added by name", "crates/telemetry/src/metrics.rs", ["telemetry"], true],
    ["everything once disabled", "crates/telemetry/src/metrics.rs", [""], true],
  ] as const)("%s", (_name, path, widened, visible) => {
    expect(sparseVisible(path, widened)).toBe(visible);
  });
});

describe("simulateRun", () => {
  it.each([
    ["from the crate's folder", "git sparse-checkout add crates/telemetry", notTopLevel, []],
    [
      "the note's command",
      'git -C "$(git rev-parse --show-toplevel)" sparse-checkout add crates/telemetry',
      "",
      ["crates/telemetry"],
    ],
    [
      "after cd to the root, then ls",
      "cd ../.. && git sparse-checkout add crates/telemetry && ls src",
      "",
      ["crates/telemetry"],
    ],
    [
      "at an absolute -C",
      `git -C ${workspaceRoot} sparse-checkout add /crates/telemetry/`,
      "",
      ["crates/telemetry"],
    ],
    [
      "with ./ from the root",
      `git -C ${workspaceRoot} sparse-checkout add ./crates/telemetry`,
      "",
      ["./crates/telemetry"],
    ],
    ["disable from anywhere", "git sparse-checkout disable", "", [""]],
    ["another command", "cargo tree -p mill", null, []],
  ] as const)("%s", (_name, command, output, widened) => {
    const into: Array<string> = [];
    expect(simulateRun(command, into)).toBe(output);
    expect(into).toEqual(widened);
  });

  it("leaves ./ patterns matching nothing", () => {
    expect(sparseVisible("crates/telemetry/src/metrics.rs", ["./crates/telemetry"])).toBe(false);
  });
});
