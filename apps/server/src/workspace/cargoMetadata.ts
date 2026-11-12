import { isCommandMissingCause } from "@t3tools/provider-core/server/snapshotProbe";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";
import * as Option from "effect/Option";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type * as ProcessRunner from "../processRunner.ts";

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
export type CargoMetadata = typeof CargoMetadata.Type;

const decodeCargoMetadata = Schema.decodeUnknownOption(Schema.fromJsonString(CargoMetadata));

// Windows paths compare by `/` and case: cargo and realPath may disagree on either.
export const comparableDir = (value: string) => {
  const trimmed = value.replace(/[\\/]+$/, "");
  return /^[a-zA-Z]:|^[\\/]{2}/.test(trimmed)
    ? trimmed.replaceAll("\\", "/").toLowerCase()
    : trimmed;
};
export const manifestDir = (manifestPath: string) => manifestPath.replace(/[\\/][^\\/]+$/, "");

const WORKSPACE_TABLE = /^\s*\[workspace\]/m;
// A toolchain name, never a path: `RUSTUP_TOOLCHAIN=/dir` would run that folder's `bin/cargo`.
const TOOLCHAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const CACHE_CAPACITY = 64;
const TOOLCHAIN_TTL_MS = 5 * 60 * 1000;

// Pinned when rustup is missing: a lone rustup `cargo` shim still proxies, and refuses this name;
// a non-rustup cargo ignores the variable.
const NO_RUSTUP_TOOLCHAIN = "t3code-no-toolchain";

export interface CargoMetadataServices {
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

/**
 * Reads `cargo metadata --no-deps` for Cargo workspaces, pinned to the user's default toolchain
 * and cached by the manifests' contents, so worktrees of one commit run cargo once.
 * Any failure yields null.
 */
export function makeCargoMetadataReader(services: CargoMetadataServices) {
  const { fileSystem, path } = services;
  const cache = new Map<number, CargoMetadata>();
  const readText = (file: string) =>
    fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => null));

  const rootOf = (dir: string): string =>
    path.dirname(dir) === dir ? dir : rootOf(path.dirname(dir));

  /** Whether `dir` holds a workspace manifest. */
  const isWorkspaceRoot = (dir: string) =>
    readText(path.join(dir, "Cargo.toml")).pipe(
      Effect.map((manifest) => manifest !== null && WORKSPACE_TABLE.test(manifest)),
    );

  /** The nearest workspace root at or above `dir`. */
  const findWorkspaceRoot = Effect.fn("CargoMetadata.findWorkspaceRoot")(function* (dir: string) {
    for (let current = dir; ; current = path.dirname(current)) {
      if (yield* isWorkspaceRoot(current)) return current;
      if (path.dirname(current) === current) return null;
    }
  });

  /** The toolchain to pin cargo to, null for none, or None when rustup failed in passing. */
  const readDefaultToolchain = (cwd: string) =>
    services.processRunner
      .run({
        command: "rustup",
        args: ["default"],
        cwd,
        timeout: "5 seconds",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.map((output): Option.Option<string | null> => {
          if (output.timedOut) return Option.none();
          const name = output.code === 0 ? (output.stdout.trim().split(/\s+/)[0] ?? "") : "";
          return Option.some(TOOLCHAIN_NAME.test(name) ? name : null);
        }),
        Effect.catch((error) =>
          Effect.succeed(
            error._tag === "ProcessSpawnError" && isCommandMissingCause(error.cause)
              ? Option.some(NO_RUSTUP_TOOLCHAIN)
              : Option.none(),
          ),
        ),
      );

  /**
   * The toolchain cargo runs on, kept for a few minutes. `cargo` is usually a rustup proxy that
   * obeys a repository's `rust-toolchain(.toml)`, which can name a folder whose `bin/cargo` it
   * then runs; pinning `RUSTUP_TOOLCHAIN` to the user's default overrides every such file.
   */
  let cachedToolchain: { readonly name: string | null; readonly at: number } | undefined;
  const resolveToolchain = Effect.fn("CargoMetadata.resolveToolchain")(function* (cwd: string) {
    const now = yield* Clock.currentTimeMillis;
    if (cachedToolchain !== undefined && now - cachedToolchain.at < TOOLCHAIN_TTL_MS) {
      return cachedToolchain.name;
    }
    const resolved = yield* readDefaultToolchain(rootOf(cwd));
    if (Option.isNone(resolved)) return null;
    cachedToolchain = { name: resolved.value, at: now };
    return resolved.value;
  });

  const runCargo = Effect.fn("CargoMetadata.runCargo")(function* (cwd: string, toolchain: string) {
    const output = yield* services.processRunner
      .run({
        command: "cargo",
        args: ["metadata", "--format-version", "1", "--no-deps", "--offline"],
        cwd,
        env: { RUSTUP_TOOLCHAIN: toolchain, RUSTUP_AUTO_INSTALL: "0" },
        timeout: "5 seconds",
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 8 * 1024 * 1024,
      })
      .pipe(Effect.option);
    if (output._tag === "None" || output.value.code !== 0 || output.value.timedOut) return null;
    return Option.getOrNull(decodeCargoMetadata(output.value.stdout));
  });

  /**
   * Metadata of the workspace rooted at the physical path `root`, run from `cwd`.
   * `extraKey` adds content the cache must also track, such as a member's own manifest.
   */
  const read = Effect.fn("CargoMetadata.read")(function* (
    root: string,
    cwd: string,
    extraKey: string,
  ) {
    const key = Hash.string(
      [
        path.relative(root, cwd),
        extraKey,
        (yield* readText(path.join(root, "Cargo.toml"))) ?? "",
        (yield* readText(path.join(root, "Cargo.lock"))) ?? "",
      ].join("\0"),
    );
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    // Without a known default toolchain, cargo would follow the repository's toolchain file.
    const toolchain = yield* resolveToolchain(cwd);
    if (toolchain === null) return null;
    const metadata = yield* runCargo(cwd, toolchain);
    // Failures stay uncached, and drop the toolchain in case it was switched or uninstalled.
    if (metadata === null) {
      cachedToolchain = undefined;
      return null;
    }
    const oldest = cache.keys().next();
    if (cache.size >= CACHE_CAPACITY && oldest.done !== true) cache.delete(oldest.value);
    cache.set(key, metadata);
    return metadata;
  });

  return { isWorkspaceRoot, findWorkspaceRoot, read };
}
