import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";
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
): string {
  if (result === null || result.dependencies.length === 0) return "";
  return `This folder is the \`${result.crate}\` crate of a Cargo workspace. Its workspace dependencies: ${result.dependencies.join(", ")}.`;
}

const WORKSPACE_TABLE = /^\s*\[workspace\]/m;
// A toolchain name, never a path: `RUSTUP_TOOLCHAIN=/dir` would run that folder's `bin/cargo`.
const TOOLCHAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
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
 * Notes are cached by the manifests' contents, so worktrees of one commit run cargo once.
 */
export function makeWorkspaceCrateNoteReader(services: WorkspaceCrateNoteServices) {
  const { fileSystem, path } = services;
  const notes = new Map<number, string>();
  const readText = (file: string) =>
    fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => null));

  const rootOf = (dir: string): string =>
    path.dirname(dir) === dir ? dir : rootOf(path.dirname(dir));

  /** The nearest workspace manifest above `cwd`. */
  const findWorkspace = Effect.fn("WorkspaceCrateNote.findWorkspace")(function* (cwd: string) {
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      const manifest = yield* readText(path.join(dir, "Cargo.toml"));
      if (manifest !== null && WORKSPACE_TABLE.test(manifest)) return dir;
      if (path.dirname(dir) === dir) return null;
    }
  });

  /**
   * The user's default rustup toolchain, read once outside any repository. `cargo` is a rustup
   * proxy that obeys a repository's `rust-toolchain(.toml)`, which can name a folder whose
   * `bin/cargo` it then runs; pinning `RUSTUP_TOOLCHAIN` overrides every such file.
   */
  let defaultToolchain: string | undefined;
  const readDefaultToolchain = Effect.fn("WorkspaceCrateNote.readDefaultToolchain")(function* (
    cwd: string,
  ) {
    if (defaultToolchain !== undefined) return defaultToolchain;
    const output = yield* services.processRunner
      .run({
        command: "rustup",
        args: ["default"],
        cwd: rootOf(cwd),
        timeout: "5 seconds",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    const name =
      output._tag === "Some" && output.value.code === 0 && !output.value.timedOut
        ? (output.value.stdout.trim().split(/\s+/)[0] ?? "")
        : "";
    if (!TOOLCHAIN_NAME.test(name)) return null;
    defaultToolchain = name;
    return name;
  });

  const runCargo = Effect.fn("WorkspaceCrateNote.runCargo")(function* (
    cwd: string,
    toolchain: string,
  ) {
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
    const metadata = decodeCargoMetadata(output.value.stdout);
    if (metadata._tag === "None") return null;
    return workspaceCrateNoteText(cargoWorkspaceDependencies(metadata.value, cwd));
  });

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
    const cached = notes.get(key);
    if (cached !== undefined) return cached;
    // Without a known default toolchain, cargo would follow the repository's toolchain file.
    const toolchain = yield* readDefaultToolchain(physicalCwd);
    if (toolchain === null) return "";
    const note = yield* runCargo(physicalCwd, toolchain);
    // Failures stay uncached so a slow or locked cargo gets another try on the next thread.
    if (note === null) return "";
    const oldest = notes.keys().next();
    if (notes.size >= CACHE_CAPACITY && oldest.done !== true) notes.delete(oldest.value);
    notes.set(key, note);
    return note;
  });
}
