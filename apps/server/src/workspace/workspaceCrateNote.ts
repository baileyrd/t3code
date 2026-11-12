import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

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
): string {
  if (result === null || result.dependencies.length === 0) return "";
  return `This folder is the \`${result.crate}\` crate of a Cargo workspace. Its workspace dependencies: ${result.dependencies.join(", ")}.`;
}

/**
 * Names the crate a thread works in and its workspace dependencies, so the agent knows where
 * to look outside its folder without running `cargo tree`. Any failure yields "": the note sits
 * on turn start, so it waits at most 5 seconds for cargo.
 */
export function makeWorkspaceCrateNoteReader(services: {
  readonly cargo: CargoMetadataReader["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  const { cargo, fileSystem, path } = services;

  return Effect.fn("readWorkspaceCrateNote")(function* (cwd: string) {
    // Cargo reports physical paths.
    const physicalCwd = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
    const ownManifest = yield* fileSystem
      .readFileString(path.join(physicalCwd, "Cargo.toml"))
      .pipe(Effect.orElseSucceed(() => null));
    if (ownManifest === null) return "";
    const workspaceRoot = yield* cargo.findWorkspaceRoot(physicalCwd);
    if (workspaceRoot === null || workspaceRoot === physicalCwd) return "";
    const metadata = yield* cargo
      .read(workspaceRoot, { timeout: "5 seconds" })
      .pipe(Effect.orElseSucceed(() => null));
    if (metadata === null) return "";
    // Cached metadata may come from another worktree of the same commit.
    const crateDir = path.join(metadata.workspace_root, path.relative(workspaceRoot, physicalCwd));
    return workspaceCrateNoteText(cargoWorkspaceDependencies(metadata, crateDir));
  });
}
