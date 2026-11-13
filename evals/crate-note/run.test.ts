import { describe, expect, it } from "vite-plus/test";
import { sparseVisible } from "./cases.ts";
import { grade, type ToolCall } from "./grade.ts";

const crateDir = "/w/crates/mill";
const dependencyDirs = ["/w/crates/rustils"];
const read = (path: string): ToolCall => ({ tool: "read_file", path });

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
    [
      "outside, widened first",
      "outside",
      [
        { tool: "run", command: "git sparse-checkout add crates/telemetry" },
        read("/w/crates/telemetry/src/metrics.rs"),
      ],
      true,
    ],
    ["outside, gave up", "outside", [read("/w/crates/telemetry/src/metrics.rs")], false],
  ] as const)("%s", (_name, kind, calls, pass) => {
    expect(grade({ kind, calls, crateDir, dependencyDirs }).pass).toBe(pass);
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
