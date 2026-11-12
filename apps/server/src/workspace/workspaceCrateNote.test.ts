import { describe, expect, it } from "vite-plus/test";

import { cargoWorkspaceDependencies, workspaceCrateNoteText } from "./workspaceCrateNote.ts";

const metadata = {
  workspace_root: "/repo",
  packages: [
    {
      name: "mill",
      manifest_path: "/repo/crates/mill/Cargo.toml",
      dependencies: [
        { name: "rustils", kind: null, path: "/repo/crates/rustils" },
        { name: "codegen", kind: "build", path: "/repo/crates/codegen" },
        { name: "test-kit", kind: "dev", path: "/repo/crates/test-kit" },
        { name: "serde", kind: null },
        { name: "vendored", kind: null, path: "/elsewhere/vendored" },
      ],
    },
    { name: "rustils", manifest_path: "/repo/crates/rustils/Cargo.toml", dependencies: [] },
    { name: "codegen", manifest_path: "/repo/crates/codegen/Cargo.toml", dependencies: [] },
    { name: "test-kit", manifest_path: "/repo/crates/test-kit/Cargo.toml", dependencies: [] },
  ],
};

describe("cargoWorkspaceDependencies", () => {
  it("lists normal and build workspace dependencies, not dev, registry or outside paths", () => {
    expect(cargoWorkspaceDependencies(metadata, "/repo/crates/mill/")).toEqual({
      crate: "mill",
      dependencies: ["codegen", "rustils"],
    });
  });

  it.each([
    ["the workspace root", "/repo"],
    ["a folder that is no member crate", "/repo/crates"],
  ])("finds nothing at %s", (_name, dir) => {
    expect(cargoWorkspaceDependencies(metadata, dir)).toBeNull();
  });
});

describe("workspaceCrateNoteText", () => {
  it("names the crate and its dependencies in one line", () => {
    expect(workspaceCrateNoteText({ crate: "mill", dependencies: ["codegen", "rustils"] })).toBe(
      "This folder is the `mill` crate of a Cargo workspace. Its workspace dependencies: codegen, rustils.",
    );
  });

  it.each([null, { crate: "rustils", dependencies: [] }])("stays silent for %o", (result) => {
    expect(workspaceCrateNoteText(result)).toBe("");
  });
});
