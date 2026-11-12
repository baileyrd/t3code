import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type * as ProcessRunner from "../processRunner.ts";
import { makePinnedCargo } from "./pinnedCargo.ts";

const CargoDependency = Schema.Struct({
  name: Schema.String,
  kind: Schema.NullOr(Schema.String),
  path: Schema.optional(Schema.String),
});

const CargoMetadata = Schema.Struct({
  workspace_root: Schema.String,
  packages: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      manifest_path: Schema.String,
      dependencies: Schema.Array(CargoDependency),
    }),
  ),
});
type CargoMetadata = typeof CargoMetadata.Type;

const decodeCargoMetadata = Schema.decodeUnknownOption(Schema.fromJsonString(CargoMetadata));

// Windows paths compare by `/` and case: cargo and realPath may disagree on either.
const comparableDir = (value: string) => {
  const trimmed = value.replace(/[\\/]+$/, "");
  return /^[a-zA-Z]:|^[\\/]{2}/.test(trimmed)
    ? trimmed.replaceAll("\\", "/").toLowerCase()
    : trimmed;
};
const manifestDir = (manifestPath: string) => manifestPath.replace(/[\\/][^\\/]+$/, "");

/** The member crate rooted at `crateDir` and the workspace crates it depends on, skipping dev-only ones. */
export function cargoWorkspaceDependencies(
  metadata: CargoMetadata,
  crateDir: string,
): { readonly crate: string; readonly dependencies: ReadonlyArray<string> } | null {
  const dir = comparableDir(crateDir);
  if (dir === comparableDir(metadata.workspace_root)) return null;
  const crateByDir = new Map(
    metadata.packages.map((pkg) => [comparableDir(manifestDir(pkg.manifest_path)), pkg.name]),
  );
  const member = metadata.packages.find((pkg) => crateByDir.get(dir) === pkg.name);
  if (member === undefined) return null;
  const dependencies = new Set<string>();
  for (const dependency of member.dependencies) {
    if (dependency.kind === "dev" || dependency.path === undefined) continue;
    const name = crateByDir.get(comparableDir(dependency.path));
    if (name !== undefined) dependencies.add(name);
  }
  return { crate: member.name, dependencies: [...dependencies].sort() };
}

/** One line for the agent; "" when there is nothing worth the tokens. */
export function workspaceCrateNoteText(
  result: ReturnType<typeof cargoWorkspaceDependencies>,
  sparse = false,
): string {
  if (result === null) return "";
  const crate = `This folder is the \`${result.crate}\` crate of a Cargo workspace.`;
  const dependencies =
    result.dependencies.length === 0
      ? ""
      : ` Its workspace dependencies: ${result.dependencies.join(", ")}.`;
  if (sparse) {
    return `${crate}${dependencies} This worktree is a sparse checkout of only those crates; run \`git sparse-checkout add <folder>\` before working in another.`;
  }
  return dependencies === "" ? "" : `${crate}${dependencies}`;
}

const WORKSPACE_TABLE = /^\s*\[workspace\]/m;
const CACHE_CAPACITY = 64;

interface WorkspaceCrateNoteServices {
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

/**
 * Names the crate a thread works in and its workspace dependencies, so the agent knows where
 * to look outside its folder without running `cargo tree`. Any failure yields "".
 *
 * Crates are cached by the manifests' contents, so worktrees of one commit run cargo once.
 */
export function makeWorkspaceCrateNoteReader(services: WorkspaceCrateNoteServices) {
  const { fileSystem, path } = services;
  const cargo = makePinnedCargo(services);
  const crates = new Map<number, ReturnType<typeof cargoWorkspaceDependencies>>();
  const readText = (file: string) =>
    fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => null));

  /** The nearest workspace manifest above `cwd`. */
  const findWorkspace = Effect.fn("WorkspaceCrateNote.findWorkspace")(function* (cwd: string) {
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      const manifest = yield* readText(path.join(dir, "Cargo.toml"));
      if (manifest !== null && WORKSPACE_TABLE.test(manifest)) return dir;
      if (path.dirname(dir) === dir) return null;
    }
  });

  const readCrate = Effect.fn("WorkspaceCrateNote.readCrate")(function* (cwd: string) {
    const stdout = yield* cargo.run({
      cwd,
      args: ["metadata", "--format-version", "1", "--no-deps", "--offline"],
      timeout: "5 seconds",
      maxOutputBytes: 8 * 1024 * 1024,
    });
    if (stdout === null) return null;
    const metadata = decodeCargoMetadata(stdout);
    if (metadata._tag === "None") return null;
    return { crate: cargoWorkspaceDependencies(metadata.value, cwd) };
  });

  const isSparseCheckout = (cwd: string) =>
    services.processRunner
      .run({
        command: "git",
        args: ["config", "--get", "--type=bool", "core.sparseCheckout"],
        cwd,
        timeout: "5 seconds",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.map((output) => output.code === 0 && output.stdout.trim() === "true"),
        Effect.orElseSucceed(() => false),
      );

  return Effect.fn("readWorkspaceCrateNote")(function* (cwd: string) {
    // Cargo reports physical paths.
    const physicalCwd = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
    const ownManifest = yield* readText(path.join(physicalCwd, "Cargo.toml"));
    if (ownManifest === null) return "";
    const workspaceRoot = yield* findWorkspace(physicalCwd);
    if (workspaceRoot === null || workspaceRoot === physicalCwd) return "";
    const key = Hash.string(
      [
        path.relative(workspaceRoot, physicalCwd),
        ownManifest,
        (yield* readText(path.join(workspaceRoot, "Cargo.toml"))) ?? "",
        (yield* readText(path.join(workspaceRoot, "Cargo.lock"))) ?? "",
      ].join("\0"),
    );
    let crate = crates.get(key);
    if (crate === undefined) {
      const read = yield* readCrate(physicalCwd);
      // Failures stay uncached so a slow or locked cargo gets another try on the next thread.
      if (read === null) return "";
      crate = read.crate;
      const oldest = crates.keys().next();
      if (crates.size >= CACHE_CAPACITY && oldest.done !== true) crates.delete(oldest.value);
      crates.set(key, crate);
    }
    if (crate === null) return "";
    return workspaceCrateNoteText(crate, yield* isSparseCheckout(physicalCwd));
  });
}
