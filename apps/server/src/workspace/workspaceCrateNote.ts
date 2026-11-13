import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

import type * as ProcessRunner from "../processRunner.ts";

import {
  type CargoMetadata,
  type CargoMetadataReader,
  comparableDir,
  manifestDir,
} from "./cargoMetadata.ts";

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
  if (result === null || (result.dependencies.length === 0 && !sparse)) return "";
  const crate = `This folder is the \`${result.crate}\` crate of a Cargo workspace.`;
  const dependencies =
    result.dependencies.length === 0
      ? ""
      : ` Its workspace dependencies: ${result.dependencies.join(", ")}.`;
  const hint = sparse
    ? ' This worktree is a sparse checkout of only those crates; run `git -C "$(git rev-parse --show-toplevel)" sparse-checkout add <path from the root>` before working in another.'
    : "";
  return `${crate}${dependencies}${hint}`;
}

/**
 * Names the crate a thread works in and its workspace dependencies, so the agent knows where
 * to look outside its folder without running `cargo tree`. Any failure yields "": the note sits
 * on turn start, so it waits at most 5 seconds for cargo.
 */
export function makeWorkspaceCrateNoteReader(services: {
  readonly cargo: CargoMetadataReader["Service"];
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  const { cargo, fileSystem, path } = services;
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
    const ownManifest = yield* fileSystem
      .readFileString(path.join(physicalCwd, "Cargo.toml"))
      .pipe(Effect.orElseSucceed(() => null));
    if (ownManifest === null) return "";
    const workspaceRoot = yield* cargo.findWorkspaceRoot(physicalCwd);
    if (workspaceRoot === null || workspaceRoot === physicalCwd) return "";
    // A cold workspace keeps loading after the turn starts, ready for the next thread.
    const metadata = yield* cargo.read(workspaceRoot).pipe(
      Effect.timeoutOption("5 seconds"),
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );
    if (metadata === null) return "";
    // Cached metadata may come from another worktree of the same commit.
    const crateDir = path.join(metadata.workspace_root, path.relative(workspaceRoot, physicalCwd));
    return workspaceCrateNoteText(
      cargoWorkspaceDependencies(metadata, crateDir),
      yield* isSparseCheckout(physicalCwd),
    );
  });
}
