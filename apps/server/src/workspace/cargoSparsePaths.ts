import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type * as ProcessRunner from "../processRunner.ts";
import type { SparseCheckoutPaths } from "../vcs/sparseCheckoutPatterns.ts";
import { makePinnedCargo } from "./pinnedCargo.ts";

const ResolvedCargoMetadata = Schema.Struct({
  packages: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      source: Schema.NullOr(Schema.String),
      manifest_path: Schema.String,
      targets: Schema.Array(Schema.Struct({ src_path: Schema.String })),
    }),
  ),
  resolve: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        deps: Schema.Array(
          Schema.Struct({
            pkg: Schema.String,
            dep_kinds: Schema.Array(Schema.Struct({ kind: Schema.NullOr(Schema.String) })),
          }),
        ),
      }),
    ),
  }),
});
type ResolvedCargoMetadata = typeof ResolvedCargoMetadata.Type;

const decodeResolvedCargoMetadata = Schema.decodeUnknownOption(
  Schema.fromJsonString(ResolvedCargoMetadata),
);

const sameDir = (left: string, right: string) => {
  const normalize = (value: string) => value.replace(/[\\/]+$/, "").replaceAll("\\", "/");
  return /^[a-zA-Z]:/.test(left)
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
};
const manifestDir = (manifestPath: string) => manifestPath.replace(/[\\/][^\\/]+$/, "");

/**
 * The crate rooted at `crateDir` and every local crate it builds against, as folders, plus every
 * local package's manifest and target files: cargo loads each member, `[patch]` and path
 * dependency to resolve the workspace, even ones this crate never builds.
 * Dev-dependencies count for the crate itself only. Null when no local crate lives at `crateDir`.
 */
export function cargoSparsePaths(
  metadata: ResolvedCargoMetadata,
  crateDir: string,
): SparseCheckoutPaths | null {
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const crate = metadata.packages.find(
    (pkg) => pkg.source === null && sameDir(manifestDir(pkg.manifest_path), crateDir),
  );
  if (crate === undefined) return null;
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const included = new Set([crate.id]);
  const pending = [crate.id];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const dependency of nodes.get(id)?.deps ?? []) {
      const devOnly = dependency.dep_kinds.every((kind) => kind.kind === "dev");
      if ((devOnly && id !== crate.id) || included.has(dependency.pkg)) continue;
      if (packages.get(dependency.pkg)?.source !== null) continue;
      included.add(dependency.pkg);
      pending.push(dependency.pkg);
    }
  }
  const directories = [...included].flatMap((id) => {
    const pkg = packages.get(id);
    return pkg === undefined ? [] : [manifestDir(pkg.manifest_path)];
  });
  const files = metadata.packages.flatMap((pkg) =>
    pkg.source === null ? [pkg.manifest_path, ...pkg.targets.map((target) => target.src_path)] : [],
  );
  return { directories, files };
}

interface CargoSparsePathServices {
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

/** Reads the sparse paths for the crate at `cwd`; null when it is no crate or cargo fails. */
export function makeCargoSparsePathReader(services: CargoSparsePathServices) {
  const cargo = makePinnedCargo(services);
  return Effect.fn("readCargoSparsePaths")(function* (cwd: string) {
    // Cargo reports physical paths.
    const physicalCwd = yield* services.fileSystem
      .realPath(cwd)
      .pipe(Effect.orElseSucceed(() => cwd));
    const stdout = yield* cargo.run({
      cwd: physicalCwd,
      // The full graph follows path dependencies through `[patch]`; --locked never writes Cargo.lock.
      args: ["metadata", "--format-version", "1", "--offline", "--locked"],
      timeout: "30 seconds",
      maxOutputBytes: 64 * 1024 * 1024,
    });
    if (stdout === null) return null;
    const metadata = decodeResolvedCargoMetadata(stdout);
    if (metadata._tag === "None") return null;
    return cargoSparsePaths(metadata.value, physicalCwd);
  });
}
