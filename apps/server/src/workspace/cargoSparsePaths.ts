import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";
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
 * The crate at `crateDir` (first) and the local crates it builds against, dev-only ones for itself
 * alone, as folders; plus every local package's manifest and targets, which cargo loads to resolve
 * the workspace. Null when no local crate lives at `crateDir`.
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

const CACHE_CAPACITY = 16;
const METADATA_ARGS = ["metadata", "--format-version", "1", "--offline", "--locked"] as const;

/**
 * `read(cwd)` gives the sparse paths for the crate at `cwd`, or null when it is no crate or cargo
 * fails. `opens(cwd)` says whether cargo can resolve the workspace from `cwd`, to check a sparse
 * worktree before handing it over. Both use the full graph, which follows path dependencies
 * through `[patch]`; --locked never writes Cargo.lock.
 */
export function makeCargoSparsePathReader(services: CargoSparsePathServices) {
  const { fileSystem, path } = services;
  const cargo = makePinnedCargo(services);
  const cache = new Map<number, SparseCheckoutPaths>();
  const readText = (file: string) =>
    fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => null));
  const runMetadata = (cwd: string) =>
    cargo.run({
      cwd,
      args: METADATA_ARGS,
      timeout: "30 seconds",
      maxOutputBytes: 64 * 1024 * 1024,
    });

  /** The crate's manifest and the nearest lockfile with its workspace manifest, or null. */
  const cacheKey = Effect.fn("CargoSparsePaths.cacheKey")(function* (cwd: string) {
    const ownManifest = yield* readText(path.join(cwd, "Cargo.toml"));
    if (ownManifest === null) return null;
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      const lock = yield* readText(path.join(dir, "Cargo.lock"));
      if (lock !== null) {
        const root = (yield* readText(path.join(dir, "Cargo.toml"))) ?? "";
        return Hash.string([cwd, ownManifest, root, lock].join("\0"));
      }
      if (path.dirname(dir) === dir) return null;
    }
  });

  const read = Effect.fn("CargoSparsePaths.read")(function* (cwd: string) {
    // Cargo reports physical paths.
    const physicalCwd = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
    const key = yield* cacheKey(physicalCwd);
    if (key === null) return null;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const stdout = yield* runMetadata(physicalCwd);
    if (stdout === null) return null;
    const metadata = decodeResolvedCargoMetadata(stdout);
    if (metadata._tag === "None") return null;
    const paths = cargoSparsePaths(metadata.value, physicalCwd);
    if (paths === null) return null;
    const oldest = cache.keys().next();
    if (cache.size >= CACHE_CAPACITY && oldest.done !== true) cache.delete(oldest.value);
    cache.set(key, paths);
    return paths;
  });

  const opens = (cwd: string) => runMetadata(cwd).pipe(Effect.map((stdout) => stdout !== null));

  return { read, opens };
}
