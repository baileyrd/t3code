import * as Effect from "effect/Effect";
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

const trimSeparators = (value: string) => value.replace(/[\\/]+$/, "");
const manifestDir = (manifestPath: string) => manifestPath.replace(/[\\/][^\\/]+$/, "");

/** The member crate rooted at `crateDir` and the workspace crates it depends on, skipping dev-only ones. */
export function cargoWorkspaceDependencies(
  metadata: CargoMetadata,
  crateDir: string,
): { readonly crate: string; readonly dependencies: ReadonlyArray<string> } | null {
  const dir = trimSeparators(crateDir);
  if (dir === trimSeparators(metadata.workspace_root)) return null;
  const crateByDir = new Map(
    metadata.packages.map((pkg) => [trimSeparators(manifestDir(pkg.manifest_path)), pkg.name]),
  );
  const member = metadata.packages.find((pkg) => crateByDir.get(dir) === pkg.name);
  if (member === undefined) return null;
  const dependencies = new Set<string>();
  for (const dependency of member.dependencies) {
    if (dependency.kind === "dev" || dependency.path === undefined) continue;
    const name = crateByDir.get(trimSeparators(dependency.path));
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
 * to look outside its folder without running `cargo tree`. Any failure yields "".
 */
export const readWorkspaceCrateNote = Effect.fn("readWorkspaceCrateNote")(function* (
  services: {
    readonly processRunner: ProcessRunner.ProcessRunner["Service"];
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  },
  cwd: string,
) {
  const hasManifest = yield* services.fileSystem
    .exists(services.path.join(cwd, "Cargo.toml"))
    .pipe(Effect.orElseSucceed(() => false));
  if (!hasManifest) return "";
  const output = yield* services.processRunner
    .run({
      command: "cargo",
      args: ["metadata", "--format-version", "1", "--no-deps", "--offline"],
      cwd,
      timeout: "5 seconds",
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: 8 * 1024 * 1024,
    })
    .pipe(Effect.option);
  if (output._tag === "None" || output.value.code !== 0 || output.value.timedOut) return "";
  const metadata = decodeCargoMetadata(output.value.stdout);
  if (metadata._tag === "None") return "";
  // Cargo reports physical paths.
  const physicalCwd = yield* services.fileSystem
    .realPath(cwd)
    .pipe(Effect.orElseSucceed(() => cwd));
  return workspaceCrateNoteText(cargoWorkspaceDependencies(metadata.value, physicalCwd));
});
