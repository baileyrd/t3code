import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import { describe, expect, it } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import {
  type CargoMetadata,
  cargoWorkspaceMembers,
  makeCargoMetadataReader,
  memberParentDirs,
} from "./cargoMetadata.ts";

const pkg = (name: string, manifestPath: string) => ({
  name,
  manifest_path: manifestPath,
  dependencies: [],
});

describe("cargoWorkspaceMembers", () => {
  it("lists members by path, without the root package or path dependencies outside it", () => {
    const metadata = {
      workspace_root: "/repo",
      packages: [
        pkg("root", "/repo/Cargo.toml"),
        pkg("mill-board", "/repo/crates/apps/mill_board/Cargo.toml"),
        pkg("rustils", "/repo/crates/libs/rustils/Cargo.toml"),
        pkg("vendored", "/elsewhere/vendored/Cargo.toml"),
      ],
    };
    expect(cargoWorkspaceMembers(metadata)).toEqual([
      { name: "mill-board", relativePath: "crates/apps/mill_board" },
      { name: "rustils", relativePath: "crates/libs/rustils" },
    ]);
  });

  it("reports Windows members with `/` separators", () => {
    const metadata = {
      workspace_root: "C:\\dev\\repo",
      packages: [pkg("mill-board", "c:\\dev\\repo\\crates\\apps\\mill_board\\Cargo.toml")],
    };
    expect(cargoWorkspaceMembers(metadata)).toEqual([
      { name: "mill-board", relativePath: "crates/apps/mill_board" },
    ]);
  });
});

describe("memberParentDirs", () => {
  it.each([
    [
      ["crates/apps/board", "crates/libs/log"],
      ["crates", "crates/apps", "crates/libs"],
    ],
    [
      ["tools", "crates/log"],
      ["", "crates"],
    ],
  ])("watches the folders above %j", (members, parents) => {
    expect(memberParentDirs(members)).toEqual(parents);
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

const metadataOf = (members: Readonly<Record<string, string>>): CargoMetadata => ({
  workspace_root: "/repo",
  packages: Object.entries(members).map(([dir, name]) => pkg(name, `/repo/${dir}/Cargo.toml`)),
});

/** A reader over a mutable tree; cargo answers with the tree's members, or with `cargo`. */
const makeReader = (input: {
  readonly cargo?: Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;
  readonly rustupDefault?: string;
}) => {
  const files = new Map<string, string>([
    ["/repo/Cargo.toml", '[workspace]\nmembers = ["crates/*"]\n'],
    ["/repo/crates/mill/Cargo.toml", '[package]\nname = "mill"\n'],
  ]);
  const members = new Map([["crates/mill", "mill"]]);
  const runs: ProcessRunner.ProcessRunInput[] = [];
  const fileSystem = FileSystem.makeNoop({
    readFileString: (file) => {
      const text = files.get(file);
      return text === undefined ? Effect.fail(notFound(file)) : Effect.succeed(text);
    },
    readDirectory: (dir) =>
      Effect.succeed(
        [...files.keys()]
          .filter((file) => file.startsWith(`${dir}/`))
          .map((file) => file.slice(dir.length + 1).split("/")[0]!)
          .filter((name, index, names) => names.indexOf(name) === index),
      ),
  });
  const processRunner = {
    run: (runInput: ProcessRunner.ProcessRunInput) =>
      Effect.suspend(() => {
        if (runInput.command === "rustup") {
          return Effect.succeed(
            input.rustupDefault === undefined
              ? output({ stdout: "stable (default)\n" })
              : output({ code: ChildProcessSpawner.ExitCode(1), stderr: input.rustupDefault }),
          );
        }
        runs.push(runInput);
        return (
          input.cargo ??
          Effect.succeed(
            output({ stdout: JSON.stringify(metadataOf(Object.fromEntries(members))) }),
          )
        );
      }),
  } as unknown as ProcessRunner.ProcessRunner["Service"];
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const reader = makeCargoMetadataReader({ processRunner, fileSystem, path });
    return {
      read: () => reader.read("/repo", { timeout: "30 seconds" }),
      runs,
      addCrate: (dir: string, name: string) => {
        files.set(`/repo/${dir}/Cargo.toml`, `[package]\nname = "${name}"\n`);
        members.set(dir, name);
      },
    };
  }).pipe(Effect.provide(Path.layer));
};

const names = (metadata: CargoMetadata) => metadata.packages.map((entry) => entry.name);

describe("makeCargoMetadataReader", () => {
  effectIt.effect("runs cargo once while the workspace is unchanged", () =>
    Effect.gen(function* () {
      const { read, runs } = yield* makeReader({});
      yield* read();
      yield* read();
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.timeout, "30 seconds");
    }),
  );

  effectIt.effect("runs cargo again for a crate added under a glob, then for a rename", () =>
    Effect.gen(function* () {
      const { read, runs, addCrate } = yield* makeReader({});
      yield* read();
      addCrate("crates/log", "log");
      assert.deepEqual(names(yield* read()), ["mill", "log"]);
      addCrate("crates/log", "rusty_log");
      assert.deepEqual(names(yield* read()), ["mill", "rusty_log"]);
      assert.equal(runs.length, 3);
    }),
  );

  effectIt.effect.each([
    [
      "cargo missing",
      { cargo: Effect.fail(missingCargo()) },
      "`cargo` is not installed on this machine.",
    ],
    [
      "a timeout",
      { cargo: Effect.succeed(output({ timedOut: true, code: null })) },
      "`cargo metadata` took too long.",
    ],
    [
      "a failing cargo",
      {
        cargo: Effect.succeed(
          output({
            code: ChildProcessSpawner.ExitCode(101),
            stderr: "warning: x\nerror: no matching package\n",
          }),
        ),
      },
      "`cargo metadata` failed: error: no matching package",
    ],
    [
      "no default toolchain",
      { rustupDefault: "error: no default toolchain configured" },
      "No default Rust toolchain is set. Run `rustup default stable`.",
    ],
  ] as const)("says why on %s", ([, input, reason]) =>
    Effect.gen(function* () {
      const { read } = yield* makeReader(input);
      const error = yield* Effect.flip(read());
      assert.equal(error.reason, reason);
    }),
  );
});

function missingCargo() {
  return new ProcessRunner.ProcessSpawnError({
    command: "cargo",
    argumentCount: 5,
    cause: notFound("cargo"),
  });
}
