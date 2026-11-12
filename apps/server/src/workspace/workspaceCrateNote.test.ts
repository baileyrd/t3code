import { assert, it as effectIt } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import { makeCargoMetadataReader } from "./cargoMetadata.ts";
import {
  cargoWorkspaceDependencies,
  makeWorkspaceCrateNoteReader,
  workspaceCrateNoteText,
} from "./workspaceCrateNote.ts";

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

  it("matches Windows paths whatever their separators and case", () => {
    const windows = {
      workspace_root: "C:\\repo",
      packages: [
        {
          name: "mill",
          manifest_path: "C:\\repo\\crates\\mill\\Cargo.toml",
          dependencies: [{ name: "rustils", kind: null, path: "C:\\repo\\crates\\rustils" }],
        },
        {
          name: "rustils",
          manifest_path: "C:\\repo\\crates\\rustils\\Cargo.toml",
          dependencies: [],
        },
      ],
    };
    expect(cargoWorkspaceDependencies(windows, "c:/repo/crates/mill")).toEqual({
      crate: "mill",
      dependencies: ["rustils"],
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

const notFound = (file: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method: "readFileString",
    pathOrDescriptor: file,
  });

const output = (
  overrides: Partial<ProcessRunner.ProcessRunOutput>,
): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});

const workspaceFiles: Readonly<Record<string, string>> = {
  "/repo/Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
  "/repo/crates/mill/Cargo.toml": '[package]\nname = "mill"\n',
};

/** A reader over `files`, with `/link` a symlink to `/repo` and cargo answering with `outputs` in turn. */
const makeReader = (input: {
  readonly files?: Readonly<Record<string, string>>;
  readonly outputs?: ReadonlyArray<ProcessRunner.ProcessRunOutput>;
  /** Answers the first cargo run instead of `outputs`. */
  readonly firstCargo?: Effect.Effect<ProcessRunner.ProcessRunOutput>;
  /** `"missing"` when rustup is not installed. */
  readonly rustupDefault?: ProcessRunner.ProcessRunOutput | "missing";
}) => {
  const files = input.files ?? workspaceFiles;
  const runs: ProcessRunner.ProcessRunInput[] = [];
  const rustupRuns: ProcessRunner.ProcessRunInput[] = [];
  const outputs = [...(input.outputs ?? [output({ stdout: JSON.stringify(metadata) })])];
  const fileSystem = FileSystem.makeNoop({
    readFileString: (file) =>
      files[file] === undefined ? Effect.fail(notFound(file)) : Effect.succeed(files[file]),
    realPath: (file) =>
      file.startsWith("/missing")
        ? Effect.fail(notFound(file))
        : Effect.succeed(file.replace(/^\/link(?=\/|$)/, "/repo")),
  });
  const processRunner = {
    run: (runInput: ProcessRunner.ProcessRunInput) =>
      Effect.suspend(() => {
        if (runInput.command !== "rustup") {
          runs.push(runInput);
          if (runs.length === 1 && input.firstCargo !== undefined) return input.firstCargo;
          return Effect.succeed(outputs.shift() ?? output({ stdout: JSON.stringify(metadata) }));
        }
        rustupRuns.push(runInput);
        if (input.rustupDefault === "missing") {
          return Effect.fail(
            new ProcessRunner.ProcessSpawnError({
              command: "rustup",
              argumentCount: 1,
              cause: notFound("rustup"),
            }),
          );
        }
        return Effect.succeed(
          input.rustupDefault ?? output({ stdout: "stable-x86_64-unknown-linux-gnu (default)\n" }),
        );
      }),
  } as unknown as ProcessRunner.ProcessRunner["Service"];
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return {
      read: makeWorkspaceCrateNoteReader({
        cargo: makeCargoMetadataReader({ processRunner, fileSystem, path }),
        fileSystem,
        path,
      }),
      runs,
      rustupRuns,
    };
  });
};

const millNote =
  "This folder is the `mill` crate of a Cargo workspace. Its workspace dependencies: codegen, rustils.";

describe("makeWorkspaceCrateNoteReader", () => {
  effectIt.effect(
    "names the crate of a folder opened through a symlink, on the default toolchain",
    () =>
      Effect.gen(function* () {
        const { read, runs, rustupRuns } = yield* makeReader({});
        assert.equal(yield* read("/link/crates/mill"), millNote);
        assert.equal(runs[0]?.cwd, "/repo");
        assert.deepEqual(runs[0]?.env, {
          RUSTUP_TOOLCHAIN: "stable-x86_64-unknown-linux-gnu",
          RUSTUP_AUTO_INSTALL: "0",
          // A branch's `.cargo/config.toml` must not pick the rustc cargo runs.
          RUSTC: "rustc",
          RUSTC_WRAPPER: "",
          RUSTC_WORKSPACE_WRAPPER: "",
          CARGO_BUILD_RUSTC: "rustc",
          CARGO_BUILD_RUSTC_WRAPPER: "",
          CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER: "",
        });
        assert.equal(rustupRuns[0]?.cwd, "/");
      }).pipe(Effect.provide(Path.layer)),
  );

  effectIt.effect("runs cargo once for worktrees with the same manifests", () =>
    Effect.gen(function* () {
      const copy = Object.fromEntries(
        Object.entries(workspaceFiles).map(([file, text]) => [file.replace("/repo", "/wt"), text]),
      );
      const { read, runs, rustupRuns } = yield* makeReader({
        files: { ...workspaceFiles, ...copy },
      });
      assert.equal(yield* read("/repo/crates/mill"), millNote);
      assert.equal(yield* read("/wt/crates/mill"), millNote);
      assert.equal(runs.length, 1);
      assert.equal(rustupRuns.length, 1);
    }).pipe(Effect.provide(Path.layer)),
  );

  effectIt.effect.each([
    ["no manifest in the folder", { "/repo/Cargo.toml": workspaceFiles["/repo/Cargo.toml"]! }],
    ["no workspace above it", { "/repo/crates/mill/Cargo.toml": "[package]\n" }],
  ] as const)("stays silent without running cargo for %s", ([, files]) =>
    Effect.gen(function* () {
      const { read, runs } = yield* makeReader({ files });
      assert.equal(yield* read("/repo/crates/mill"), "");
      assert.equal(runs.length, 0);
    }).pipe(Effect.provide(Path.layer)),
  );

  effectIt.effect.each([
    ["a failing cargo", output({ code: ChildProcessSpawner.ExitCode(101) })],
    ["a timeout", output({ timedOut: true, code: null })],
    ["output that is not metadata", output({ stdout: "{" })],
  ] as const)("stays silent on %s and tries again next time", ([, failure]) =>
    Effect.gen(function* () {
      const { read, runs, rustupRuns } = yield* makeReader({ outputs: [failure] });
      assert.equal(yield* read("/repo/crates/mill"), "");
      yield* TestClock.adjust("10 seconds");
      assert.equal(yield* read("/repo/crates/mill"), millNote);
      assert.equal(runs.length, 2);
      assert.equal(rustupRuns.length, 2);
    }).pipe(Effect.provide(Path.layer)),
  );

  effectIt.effect("stops waiting after 5 seconds and leaves cargo's answer for the next turn", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const { read, runs } = yield* makeReader({
        firstCargo: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.as(output({ stdout: JSON.stringify(metadata) })),
        ),
      });
      const first = yield* Effect.forkChild(read("/repo/crates/mill"));
      yield* Deferred.await(started);
      yield* TestClock.adjust("5 seconds");
      assert.equal(yield* Fiber.join(first), "");
      yield* Deferred.succeed(gate, undefined);
      assert.equal(yield* read("/repo/crates/mill"), millNote);
      assert.equal(runs.length, 1);
    }).pipe(Effect.provide(Path.layer)),
  );

  effectIt.effect("uses the folder as given when its real path can't be read", () =>
    Effect.gen(function* () {
      const files = Object.fromEntries(
        Object.entries(workspaceFiles).map(([file, text]) => [
          file.replace("/repo", "/missing"),
          text,
        ]),
      );
      const { read, runs } = yield* makeReader({ files });
      yield* read("/missing/crates/mill");
      assert.equal(runs[0]?.cwd, "/missing");
    }).pipe(Effect.provide(Path.layer)),
  );

  effectIt.effect.each([
    ["no rustup default", output({ code: ChildProcessSpawner.ExitCode(1) })],
    ["a default that is a folder", output({ stdout: "/opt/evil (default)\n" })],
  ] as const)("stays silent without running cargo for %s", ([, rustupDefault]) =>
    Effect.gen(function* () {
      const { read, runs, rustupRuns } = yield* makeReader({ rustupDefault });
      assert.equal(yield* read("/repo/crates/mill"), "");
      assert.equal(yield* read("/repo/crates/mill"), "");
      assert.equal(runs.length, 0);
      assert.equal(rustupRuns.length, 1);
      yield* TestClock.adjust("5 minutes");
      yield* read("/repo/crates/mill");
      assert.equal(rustupRuns.length, 2);
    }).pipe(Effect.provide(Path.layer)),
  );

  effectIt.effect("pins a toolchain no rustup shim has when rustup is not installed", () =>
    Effect.gen(function* () {
      const { read, runs } = yield* makeReader({ rustupDefault: "missing" });
      assert.equal(yield* read("/repo/crates/mill"), millNote);
      assert.include(runs[0]?.env, { RUSTUP_TOOLCHAIN: "t3code-no-toolchain" });
    }).pipe(Effect.provide(Path.layer)),
  );

  effectIt.effect("asks rustup again after it timed out", () =>
    Effect.gen(function* () {
      const { read, rustupRuns } = yield* makeReader({
        rustupDefault: output({ timedOut: true, code: null }),
      });
      assert.equal(yield* read("/repo/crates/mill"), "");
      yield* TestClock.adjust("10 seconds");
      assert.equal(yield* read("/repo/crates/mill"), "");
      assert.equal(rustupRuns.length, 2);
    }).pipe(Effect.provide(Path.layer)),
  );
});
