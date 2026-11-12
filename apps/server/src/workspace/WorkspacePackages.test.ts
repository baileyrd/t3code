import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import { describe, expect, it } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as WorkspacePackages from "./WorkspacePackages.ts";

const pkg = (name: string, manifestPath: string) => ({
  name,
  manifest_path: manifestPath,
  dependencies: [],
});

describe("cargoWorkspacePackages", () => {
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
    expect(WorkspacePackages.cargoWorkspacePackages(metadata)).toEqual([
      { name: "mill-board", relativePath: "crates/apps/mill_board" },
      { name: "rustils", relativePath: "crates/libs/rustils" },
    ]);
  });

  it("reports Windows members with `/` separators", () => {
    const metadata = {
      workspace_root: "C:\\dev\\repo",
      packages: [pkg("mill-board", "c:\\dev\\repo\\crates\\apps\\mill_board\\Cargo.toml")],
    };
    expect(WorkspacePackages.cargoWorkspacePackages(metadata)).toEqual([
      { name: "mill-board", relativePath: "crates/apps/mill_board" },
    ]);
  });
});

const notFound = (file: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method: "readFileString",
    pathOrDescriptor: file,
  });

const cargoOutput = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

/** The service over `files`, with `/link` a symlink to `/repo`. */
const listWith = (files: Readonly<Record<string, string>>, path: string) => {
  const cargoRuns: ProcessRunner.ProcessRunInput[] = [];
  const metadata = {
    workspace_root: "/repo",
    packages: [pkg("mill-board", "/repo/crates/apps/mill_board/Cargo.toml")],
  };
  const processRunner = {
    run: (input: ProcessRunner.ProcessRunInput) =>
      Effect.sync(() => {
        if (input.command === "cargo") cargoRuns.push(input);
        return cargoOutput(input.command === "cargo" ? JSON.stringify(metadata) : "stable\n");
      }),
  } as unknown as ProcessRunner.ProcessRunner["Service"];
  const layer = Layer.effect(WorkspacePackages.WorkspacePackages, WorkspacePackages.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, processRunner),
        FileSystem.layerNoop({
          readFileString: (file) =>
            files[file] === undefined ? Effect.fail(notFound(file)) : Effect.succeed(files[file]),
          realPath: (file) => Effect.succeed(file.replace(/^\/link(?=\/|$)/, "/repo")),
        }),
        Path.layer,
      ),
    ),
  );
  return WorkspacePackages.WorkspacePackages.use((service) => service.list({ path })).pipe(
    Effect.map((result) => ({ ...result, cargoRuns })),
    Effect.provide(layer),
  );
};

describe("WorkspacePackages.list", () => {
  effectIt.effect("lists members under the folder as the user spelled it", () =>
    Effect.gen(function* () {
      const result = yield* listWith(
        { "/repo/Cargo.toml": '[workspace]\nmembers = ["crates/*/*"]\n' },
        "/link",
      );
      assert.deepEqual(result.packages, [
        {
          name: "mill-board",
          relativePath: "crates/apps/mill_board",
          fullPath: "/link/crates/apps/mill_board",
        },
      ]);
      assert.equal(result.cargoRuns[0]?.cwd, "/repo");
    }),
  );

  effectIt.effect.each([
    [
      "a package that is no workspace",
      { "/repo/Cargo.toml": '[package]\nname = "solo"\n' },
      "/repo",
    ],
    ["a folder without a manifest", {}, "/repo"],
    ["a relative path", { "/repo/Cargo.toml": "[workspace]\n" }, "repo"],
  ] as const)("finds nothing, without running cargo, for %s", ([, files, path]) =>
    Effect.gen(function* () {
      const result = yield* listWith(files, path);
      assert.deepEqual(result.packages, []);
      assert.equal(result.cargoRuns.length, 0);
    }),
  );
});
