import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import { describe, expect, it } from "vite-plus/test";

import type * as ProcessRunner from "../processRunner.ts";
import { makeCargoMetadataReader } from "./cargoMetadata.ts";
import { cargoSparsePaths, makeCargoSparsePathReader } from "./cargoSparsePaths.ts";

const local = (name: string, dir: string, targets: ReadonlyArray<string> = ["src/lib.rs"]) => ({
  id: `path+file://${dir}#${name}`,
  source: null,
  manifest_path: `${dir}/Cargo.toml`,
  targets: targets.map((target) => ({ src_path: `${dir}/${target}` })),
});
const node = (
  id: string,
  deps: ReadonlyArray<readonly [string, ReadonlyArray<string | null>]>,
) => ({
  id,
  deps: deps.map(([pkg, kinds]) => ({ pkg, dep_kinds: kinds.map((kind) => ({ kind })) })),
});

const board = local("board", "/repo/crates/apps/board", ["src/main.rs", "build.rs"]);
const http = local("http", "/repo/crates/http");
const tls = local("tls", "/repo/crates/tls");
const testKit = local("test-kit", "/repo/crates/test-kit");
const fixtures = local("fixtures", "/repo/crates/fixtures");
const unrelated = local("unrelated", "/repo/crates/unrelated");
const patched = local("jsonwebtoken", "/repo/vendor/jsonwebtoken");
const serde = {
  id: "registry+https://github.com/rust-lang/crates.io-index#serde@1.0.0",
  source: "registry+https://github.com/rust-lang/crates.io-index",
  manifest_path: "/home/.cargo/registry/serde/Cargo.toml",
  targets: [{ src_path: "/home/.cargo/registry/serde/src/lib.rs" }],
};

const metadata = {
  packages: [board, http, tls, testKit, fixtures, unrelated, patched, serde],
  resolve: {
    nodes: [
      node(board.id, [
        [http.id, [null]],
        [testKit.id, ["dev"]],
        [serde.id, [null]],
      ]),
      node(http.id, [
        [tls.id, ["build"]],
        [fixtures.id, ["dev"]],
        [patched.id, [null, "dev"]],
      ]),
      node(tls.id, []),
      node(testKit.id, []),
      node(fixtures.id, []),
      node(unrelated.id, []),
      node(patched.id, []),
      node(serde.id, []),
    ],
  },
};

describe("cargoSparsePaths", () => {
  it("holds the crate's local build graph whole and every local package's manifest and targets", () => {
    const paths = cargoSparsePaths(metadata, "/repo/crates/apps/board/");
    expect([...(paths?.directories ?? [])].sort()).toEqual([
      "/repo/crates/apps/board",
      "/repo/crates/http",
      "/repo/crates/test-kit",
      "/repo/crates/tls",
      "/repo/vendor/jsonwebtoken",
    ]);
    expect(paths?.files).toContain("/repo/crates/unrelated/Cargo.toml");
    expect(paths?.files).toContain("/repo/crates/unrelated/src/lib.rs");
    expect(paths?.files).toContain("/repo/crates/apps/board/build.rs");
    expect(paths?.files).toContain("/repo/vendor/jsonwebtoken/Cargo.toml");
    expect(paths?.files).not.toContain("/home/.cargo/registry/serde/Cargo.toml");
  });

  it("matches a Windows folder whatever its separators and case", () => {
    const windows = {
      ...metadata,
      packages: metadata.packages.map((pkg) => ({
        ...pkg,
        manifest_path: pkg.manifest_path.replace("/repo", "C:\\repo").replaceAll("/", "\\"),
      })),
    };
    expect(cargoSparsePaths(windows, "c:/REPO/crates/apps/board")?.directories).toContain(
      "C:\\repo\\crates\\apps\\board",
    );
  });

  it("finds nothing outside a local crate", () => {
    expect(cargoSparsePaths(metadata, "/repo/crates")).toBeNull();
  });
});

const notFound = (file: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method: "readFileString",
    pathOrDescriptor: file,
  });

const succeeded = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const workspace: Readonly<Record<string, string>> = {
  "/repo/Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
  "/repo/Cargo.lock": "version = 4\n",
  "/repo/crates/apps/board/Cargo.toml": '[package]\nname = "board"\n',
};

/** A reader over the mutable `files`, counting the cargo runs it makes. */
const makeReader = (files: Record<string, string>) => {
  const runs: string[] = [];
  const fileSystem = FileSystem.makeNoop({
    readFileString: (file) =>
      files[file] === undefined ? Effect.fail(notFound(file)) : Effect.succeed(files[file]),
    realPath: (file) => Effect.succeed(file),
  });
  const processRunner = {
    run: (input: ProcessRunner.ProcessRunInput) =>
      Effect.sync(() => {
        if (input.command === "rustup") return succeeded("stable (default)\n");
        runs.push(input.cwd ?? "");
        return succeeded(JSON.stringify(metadata));
      }),
  } as unknown as ProcessRunner.ProcessRunner["Service"];
  return Effect.map(Path.Path, (path) => ({
    read: makeCargoSparsePathReader({
      cargo: makeCargoMetadataReader({ processRunner, fileSystem, path }),
      fileSystem,
      path,
    }).read,
    runs,
  }));
};

describe("makeCargoSparsePathReader", () => {
  effectIt.effect("runs cargo again only when a manifest or the lockfile changes", () =>
    Effect.gen(function* () {
      const files = { ...workspace };
      const { read, runs } = yield* makeReader(files);
      const first = yield* read("/repo/crates/apps/board");
      assert.deepEqual(first?.directories[0], "/repo/crates/apps/board");
      yield* read("/repo/crates/apps/board");
      assert.equal(runs.length, 1);
      files["/repo/Cargo.lock"] = "version = 4\n# changed\n";
      yield* read("/repo/crates/apps/board");
      assert.equal(runs.length, 2);
    }).pipe(Effect.provide(Path.layer)),
  );

  effectIt.effect.each([
    ["no manifest in the folder", { "/repo/Cargo.lock": "version = 4\n" }],
    ["no lockfile above it", { "/repo/crates/apps/board/Cargo.toml": "[package]\n" }],
  ] as const)("reads nothing without running cargo for %s", ([, files]) =>
    Effect.gen(function* () {
      const { read, runs } = yield* makeReader({ ...files });
      assert.isNull(yield* read("/repo/crates/apps/board"));
      assert.equal(runs.length, 0);
    }).pipe(Effect.provide(Path.layer)),
  );
});
