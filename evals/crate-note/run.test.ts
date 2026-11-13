import { describe, expect, it } from "vite-plus/test";
import { workspaceRoot } from "./cases.ts";
import { grade, type ToolCall } from "./grade.ts";
import { notTopLevel, simulateRun, sparseStart, sparseVisible, type Sparse } from "./sandbox.ts";

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
    [
      "replaced the checkout with set",
      [{ tool: "run", command: "git sparse-checkout set crates/telemetry" }, read(target)],
      false,
    ],
  ] as const)("outside, %s", (_name, calls, pass) => {
    expect(grade({ kind: "outside", target, calls, crateDir, dependencyDirs }).pass).toBe(pass);
  });
});

const added = (...patterns: Array<string>): Sparse => ({ base: true, patterns });
const replaced = (...patterns: Array<string>): Sparse => ({ base: false, patterns });

describe("sparseVisible", () => {
  it.each([
    ["the crate", "crates/mill/src/retry.rs", added(), true],
    ["a dependency", "crates/rustils/src/backoff.rs", added(), true],
    ["another crate's target file", "crates/telemetry/src/lib.rs", added(), true],
    ["another crate's module", "crates/telemetry/src/metrics.rs", added(), false],
    ["it once added", "crates/telemetry/src/metrics.rs", added("crates/telemetry"), true],
    ["it once added by name", "crates/telemetry/src/metrics.rs", added("telemetry"), true],
    [
      "an inner-slash pattern, unanchored",
      "crates/telemetry/src/metrics.rs",
      added("telemetry/src"),
      false,
    ],
    ["a root-anchored folder", "crates/telemetry/src/metrics.rs", added("/crates/telemetry"), true],
    ["a root-anchored bare name", "crates/telemetry/src/metrics.rs", added("/telemetry"), false],
    [
      "a single file",
      "crates/telemetry/src/metrics.rs",
      added("crates/telemetry/src/metrics.rs"),
      true,
    ],
    ["a ./ pattern", "crates/telemetry/src/metrics.rs", added("./crates/telemetry"), false],
    ["everything once disabled", "crates/telemetry/src/metrics.rs", added(""), true],
    ["the crate after set", "crates/mill/src/retry.rs", replaced("crates/telemetry"), false],
  ] as const)("%s", (_name, path, sparse, visible) => {
    expect(sparseVisible(path, sparse)).toBe(visible);
  });
});

const root = `git -C ${workspaceRoot} sparse-checkout`;

describe("simulateRun", () => {
  it.each([
    ["from the crate's folder", "git sparse-checkout add crates/telemetry", notTopLevel, added()],
    [
      "the note's command",
      'git -C "$(git rev-parse --show-toplevel)" sparse-checkout add crates/telemetry',
      "",
      added("crates/telemetry"),
    ],
    [
      "after cd to the root, then ls",
      "cd ../.. && git sparse-checkout add crates/telemetry && ls src | head",
      "",
      added("crates/telemetry"),
    ],
    ["at an absolute -C", `${root} add /crates/telemetry/`, "", added("/crates/telemetry")],
    ["with ./ from the root", `${root} add ./crates/telemetry`, "", added("./crates/telemetry")],
    ["set replaces everything", `${root} set crates/telemetry`, "", replaced("crates/telemetry")],
    ["list", `${root} list`, "crates/mill\ncrates/rustils\n", added()],
    ["disable from anywhere", "git sparse-checkout disable", "", added("")],
    ["another command", "cargo tree -p mill", null, added()],
  ] as const)("%s", (_name, command, output, after) => {
    const sparse = sparseStart();
    expect(simulateRun(command, sparse)).toBe(output);
    expect(sparse).toEqual(after);
  });
});
