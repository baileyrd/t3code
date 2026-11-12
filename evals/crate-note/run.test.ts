import { describe, expect, it } from "vite-plus/test";
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
  ] as const)("%s", (_name, kind, calls, pass) => {
    expect(grade({ kind, calls, crateDir, dependencyDirs }).pass).toBe(pass);
  });
});
