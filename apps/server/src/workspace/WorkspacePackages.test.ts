import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import { describe } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as CargoMetadata from "./cargoMetadata.ts";
import * as WorkspacePackages from "./WorkspacePackages.ts";

const pkg = (name: string, manifestPath: string) => ({
  name,
  manifest_path: manifestPath,
  dependencies: [],
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
const listWith = (files: Readonly<Record<string, string>>, path: string, cargoExit: number = 0) => {
  const cargoRuns: ProcessRunner.ProcessRunInput[] = [];
  const metadata = {
    workspace_root: "/repo",
    packages: [pkg("mill-board", "/repo/crates/apps/mill_board/Cargo.toml")],
  };
  const processRunner = {
    run: (input: ProcessRunner.ProcessRunInput) =>
      Effect.sync(() => {
        if (input.command === "cargo") cargoRuns.push(input);
        if (input.command !== "cargo") return cargoOutput("stable\n");
        return cargoExit === 0
          ? cargoOutput(JSON.stringify(metadata))
          : {
              ...cargoOutput(""),
              code: ChildProcessSpawner.ExitCode(cargoExit),
              stderr: "error: failed to parse manifest at `/repo/crates/x/Cargo.toml`\n",
            };
      }),
  } as unknown as ProcessRunner.ProcessRunner["Service"];
  const layer = Layer.effect(WorkspacePackages.WorkspacePackages, WorkspacePackages.make).pipe(
    Layer.provide(CargoMetadata.layer),
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
      assert.deepEqual(result.status === "ok" ? result.packages : result, [
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
  ] as const)("reports no workspace, without running cargo, for %s", ([, files, path]) =>
    Effect.gen(function* () {
      const result = yield* listWith(files, path);
      assert.equal(result.status, "not-workspace");
      assert.equal(result.cargoRuns.length, 0);
    }),
  );

  effectIt.effect("says why a workspace could not be listed, giving cargo 30 seconds", () =>
    Effect.gen(function* () {
      const result = yield* listWith({ "/repo/Cargo.toml": "[workspace]\n" }, "/repo", 101);
      assert.deepEqual(
        result.status === "failed" ? result.reason : result.status,
        "`cargo metadata` failed: error: failed to parse manifest at `/repo/crates/x/Cargo.toml`",
      );
      assert.equal(result.cargoRuns[0]?.timeout, "30 seconds");
    }),
  );
});
