import type {
  FilesystemWorkspacePackagesInput,
  FilesystemWorkspacePackagesResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as CargoMetadata from "./cargoMetadata.ts";

/** Lists the member packages of a workspace root, so a monorepo can be added one package at a time. */
export class WorkspacePackages extends Context.Service<
  WorkspacePackages,
  {
    readonly list: (
      input: FilesystemWorkspacePackagesInput,
    ) => Effect.Effect<FilesystemWorkspacePackagesResult>;
  }
>()("t3/workspace/WorkspacePackages") {}

const NOT_WORKSPACE: FilesystemWorkspacePackagesResult = { status: "not-workspace" };

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cargo = yield* CargoMetadata.CargoMetadataReader;

  const list = Effect.fn("WorkspacePackages.list")(function* (
    input: FilesystemWorkspacePackagesInput,
  ) {
    if (!path.isAbsolute(input.path)) return NOT_WORKSPACE;
    // Cargo reports physical paths.
    const root = yield* fileSystem
      .realPath(input.path)
      .pipe(Effect.orElseSucceed(() => input.path));
    if (!(yield* cargo.isWorkspaceRoot(root))) return NOT_WORKSPACE;
    // Someone is waiting on this list, unlike the crate note on turn start, so cargo gets longer.
    return yield* cargo.read(root, { timeout: "30 seconds" }).pipe(
      Effect.map((metadata): FilesystemWorkspacePackagesResult => ({
        status: "ok",
        packages: CargoMetadata.cargoWorkspaceMembers(metadata).map((pkg) => ({
          ...pkg,
          fullPath: path.join(input.path, pkg.relativePath),
        })),
      })),
      Effect.catchTags({
        CargoMetadataError: (error) =>
          Effect.succeed<FilesystemWorkspacePackagesResult>({
            status: "failed",
            reason: error.reason,
          }),
      }),
    );
  });

  return WorkspacePackages.of({ list });
});

export const layer = Layer.effect(WorkspacePackages, make);
