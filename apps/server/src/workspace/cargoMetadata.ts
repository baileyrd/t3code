import { isCommandMissingCause } from "@t3tools/provider-core/server/snapshotProbe";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

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

/** Why a workspace could not be read, worded for the person who sees it. */
export class CargoMetadataError extends Schema.TaggedError<CargoMetadataError>()(
  "CargoMetadataError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

// Windows paths compare by `/` and case: cargo and realPath may disagree on either.
export const comparableDir = (value: string) => {
  const trimmed = value.replace(/[\\/]+$/, "");
  return /^[a-zA-Z]:|^[\\/]{2}/.test(trimmed)
    ? trimmed.replaceAll("\\", "/").toLowerCase()
    : trimmed;
};
export const manifestDir = (manifestPath: string) => manifestPath.replace(/[\\/][^\\/]+$/, "");

/** Member packages below the workspace root, by `/`-separated path; the root's own package is the root. */
export function cargoWorkspaceMembers(
  metadata: CargoMetadata,
): ReadonlyArray<{ readonly name: string; readonly relativePath: string }> {
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

/** Folders whose listing changes when a member crate is added: every folder above a member, the root only when a member sits in it. */
export function memberParentDirs(memberDirs: ReadonlyArray<string>): ReadonlyArray<string> {
  const parents = new Set<string>();
  for (const dir of memberDirs) {
    const segments = dir.split("/");
    if (segments.length === 1) parents.add("");
    for (let depth = 1; depth < segments.length; depth++) {
      parents.add(segments.slice(0, depth).join("/"));
    }
  }
  return [...parents].toSorted();
}

const WORKSPACE_TABLE = /^\s*\[workspace\]/m;
// A toolchain name, never a path: `RUSTUP_TOOLCHAIN=/dir` would run that folder's `bin/cargo`.
const TOOLCHAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const CACHE_CAPACITY = 16;
const TOOLCHAIN_TTL_MS = 5 * 60 * 1000;

// Pinned when rustup is missing: a lone rustup `cargo` shim still proxies, and refuses this name;
// a non-rustup cargo ignores the variable.
const NO_RUSTUP_TOOLCHAIN = "t3code-no-toolchain";

const fail = (reason: string) => Effect.fail(new CargoMetadataError({ reason }));

const remember = <K, V>(map: Map<K, V>, key: K, value: V) => {
  const oldest = map.keys().next();
  if (map.size >= CACHE_CAPACITY && oldest.done !== true) map.delete(oldest.value);
  map.set(key, value);
};

export interface CargoMetadataServices {
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

/**
 * Reads `cargo metadata --no-deps` for Cargo workspaces, pinned to the user's default toolchain.
 *
 * Results are cached by the content of the root and member manifests and the listings of the
 * folders members live in, so worktrees of one commit run cargo once and a new, renamed or
 * re-pointed crate runs it again.
 */
export function makeCargoMetadataReader(services: CargoMetadataServices) {
  const { fileSystem, path } = services;
  const metadataByFingerprint = new Map<number, CargoMetadata>();
  const membersByRootManifest = new Map<number, ReadonlyArray<string>>();
  const readText = (file: string) =>
    fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => null));
  const listNames = (dir: string) =>
    fileSystem.readDirectory(dir).pipe(
      Effect.map((names) => names.toSorted().join("/")),
      Effect.orElseSucceed(() => "\0missing"),
    );

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

  const fingerprint = Effect.fn("CargoMetadata.fingerprint")(function* (
    root: string,
    rootManifest: string,
    memberDirs: ReadonlyArray<string>,
  ) {
    const manifests = yield* Effect.forEach(
      memberDirs,
      (dir) => readText(path.join(root, dir, "Cargo.toml")).pipe(Effect.map((text) => text ?? "")),
      { concurrency: 16 },
    );
    const parents = memberParentDirs(memberDirs);
    const listings = yield* Effect.forEach(parents, (dir) => listNames(path.join(root, dir)), {
      concurrency: 16,
    });
    return Hash.string(
      [rootManifest, ...memberDirs, ...manifests, ...parents, ...listings].join("\0"),
    );
  });

  /** The toolchain to pin cargo to; None when rustup failed in passing. */
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
    if (cachedToolchain === undefined || now - cachedToolchain.at >= TOOLCHAIN_TTL_MS) {
      const resolved = yield* readDefaultToolchain(rootOf(cwd));
      if (Option.isNone(resolved))
        return yield* fail("`rustup default` did not answer. Try again.");
      cachedToolchain = { name: resolved.value, at: now };
    }
    // Without a known default toolchain, cargo would follow the repository's toolchain file.
    if (cachedToolchain.name === null) {
      return yield* fail("No default Rust toolchain is set. Run `rustup default stable`.");
    }
    return cachedToolchain.name;
  });

  const runCargo = Effect.fn("CargoMetadata.runCargo")(function* (
    root: string,
    toolchain: string,
    timeout: Duration.Input,
  ) {
    const output = yield* services.processRunner
      .run({
        command: "cargo",
        args: ["metadata", "--format-version", "1", "--no-deps", "--offline"],
        cwd: root,
        env: { RUSTUP_TOOLCHAIN: toolchain, RUSTUP_AUTO_INSTALL: "0" },
        timeout,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 8 * 1024 * 1024,
      })
      .pipe(
        Effect.catch((error) =>
          fail(
            error._tag === "ProcessSpawnError" && isCommandMissingCause(error.cause)
              ? "`cargo` is not installed on this machine."
              : `\`cargo metadata\` could not run: ${error.message}`,
          ),
        ),
      );
    if (output.timedOut) return yield* fail("`cargo metadata` took too long.");
    if (output.code !== 0) {
      const detail = output.stderr.trim().split("\n").at(-1)?.slice(0, 200) ?? "";
      return yield* fail(`\`cargo metadata\` failed${detail === "" ? "." : `: ${detail}`}`);
    }
    const metadata = decodeCargoMetadata(output.stdout);
    if (Option.isNone(metadata)) return yield* fail("`cargo metadata` gave unreadable output.");
    return metadata.value;
  });

  /** Metadata of the workspace rooted at the physical path `root`. */
  const read = Effect.fn("CargoMetadata.read")(function* (
    root: string,
    options: { readonly timeout: Duration.Input },
  ) {
    const rootManifest = yield* readText(path.join(root, "Cargo.toml"));
    if (rootManifest === null) return yield* fail("This folder has no `Cargo.toml`.");
    const rootKey = Hash.string(rootManifest);
    const knownMembers = membersByRootManifest.get(rootKey);
    if (knownMembers !== undefined) {
      const cached = metadataByFingerprint.get(
        yield* fingerprint(root, rootManifest, knownMembers),
      );
      if (cached !== undefined) return cached;
    }
    const toolchain = yield* resolveToolchain(root);
    const metadata = yield* runCargo(root, toolchain, options.timeout).pipe(
      // Drop the toolchain in case it was switched or uninstalled.
      Effect.tapError(() => Effect.sync(() => (cachedToolchain = undefined))),
    );
    const members = cargoWorkspaceMembers(metadata).map((member) => member.relativePath);
    remember(membersByRootManifest, rootKey, members);
    remember(metadataByFingerprint, yield* fingerprint(root, rootManifest, members), metadata);
    return metadata;
  });

  return { isWorkspaceRoot, findWorkspaceRoot, read };
}

/** One reader per server, so the crate note and the package list share its cache. */
export class CargoMetadataReader extends Context.Service<
  CargoMetadataReader,
  ReturnType<typeof makeCargoMetadataReader>
>()("t3/workspace/cargoMetadata/CargoMetadataReader") {}

export const layer = Layer.effect(
  CargoMetadataReader,
  Effect.gen(function* () {
    return makeCargoMetadataReader({
      processRunner: yield* ProcessRunner.ProcessRunner,
      fileSystem: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
    });
  }),
);

/** Shared by reference, so one server build makes one reader. */
export const layerLive = layer.pipe(Layer.provide(ProcessRunner.layer));
