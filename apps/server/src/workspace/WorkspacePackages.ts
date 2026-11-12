import type {
  FilesystemWorkspacePackage,
  FilesystemWorkspacePackagesInput,
  FilesystemWorkspacePackagesResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import {
  type CargoMetadata,
  comparableDir,
  makeCargoMetadataReader,
  manifestDir,
} from "./cargoMetadata.ts";

/** Lists the member packages of a workspace root, so a monorepo can be added one package at a time. */
export class WorkspacePackages extends Context.Service<
  WorkspacePackages,
  {
    readonly list: (
      input: FilesystemWorkspacePackagesInput,
    ) => Effect.Effect<FilesystemWorkspacePackagesResult>;
  }
>()("t3/workspace/WorkspacePackages") {}

/** Member packages below the workspace root, by path; the root's own package is the root. */
export function cargoWorkspacePackages(
  metadata: CargoMetadata,
): ReadonlyArray<Omit<FilesystemWorkspacePackage, "fullPath">> {
  const root = `${comparableDir(metadata.workspace_root)}/`;
  return metadata.packages
    .flatMap((pkg) => {
      const dir = manifestDir(pkg.manifest_path).replaceAll("\\", "/");
      return comparableDir(dir).startsWith(root)
        ? [{ name: pkg.name, relativePath: dir.slice(root.length) }]
        : [];
    })
    .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath));
}

const EMPTY: FilesystemWorkspacePackagesResult = { packages: [] };

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cargo = makeCargoMetadataReader({
    processRunner: yield* ProcessRunner.ProcessRunner,
    fileSystem,
    path,
  });

  const list = Effect.fn("WorkspacePackages.list")(function* (
    input: FilesystemWorkspacePackagesInput,
  ) {
    if (!path.isAbsolute(input.path)) return EMPTY;
    // Cargo reports physical paths.
    const root = yield* fileSystem
      .realPath(input.path)
      .pipe(Effect.orElseSucceed(() => input.path));
    if (!(yield* cargo.isWorkspaceRoot(root))) return EMPTY;
    const metadata = yield* cargo.read(root, root, "");
    if (metadata === null) return EMPTY;
    return {
      packages: cargoWorkspacePackages(metadata).map((pkg) => ({
        ...pkg,
        fullPath: path.join(input.path, pkg.relativePath),
      })),
    };
  });

  return WorkspacePackages.of({ list });
});

export const layer = Layer.effect(WorkspacePackages, make).pipe(Layer.provide(ProcessRunner.layer));
