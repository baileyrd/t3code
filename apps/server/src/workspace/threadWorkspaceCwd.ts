import { projectScriptCwd, projectSubdirectory } from "@t3tools/shared/projectScripts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import type * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

interface WorkspaceServices {
  readonly vcs: VcsDriverRegistry.VcsDriverRegistry["Service"];
  readonly fileSystem: FileSystem.FileSystem;
}

export class ThreadWorkspaceFolderMissingError extends Schema.TaggedError<ThreadWorkspaceFolderMissingError>()(
  "ThreadWorkspaceFolderMissingError",
  { worktreePath: Schema.String, subdirectory: Schema.String },
) {
  override get message(): string {
    return `The project folder \`${this.subdirectory}\` does not exist in the worktree ${this.worktreePath}.`;
  }
}

/**
 * The project's folder below its repository root, `/`-separated; "" at the root, and null outside a
 * repository. Git reports physical roots, so both sides are compared as real paths.
 */
export const resolveProjectSubdirectory = Effect.fn("resolveProjectSubdirectory")(function* (
  services: WorkspaceServices,
  workspaceRoot: string,
) {
  const repositoryRoot = yield* services.vcs.detect({ cwd: workspaceRoot }).pipe(
    Effect.map((handle) => handle?.repository.rootPath ?? null),
    Effect.orElseSucceed(() => null),
  );
  if (repositoryRoot === null) return null;
  const realPath = (path: string) =>
    services.fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));
  return projectSubdirectory(yield* realPath(repositoryRoot), yield* realPath(workspaceRoot));
});

/**
 * Where a thread's agent, scripts and terminals work: the project folder, or the same folder inside
 * the thread's worktree. Fails rather than falling back to the worktree root when it is missing.
 */
export const resolveThreadWorkspaceCwd = Effect.fn("resolveThreadWorkspaceCwd")(function* (
  services: WorkspaceServices,
  input: { readonly workspaceRoot: string; readonly worktreePath: string | null },
) {
  const { worktreePath, workspaceRoot } = input;
  if (worktreePath === null) return workspaceRoot;
  const subdirectory = yield* resolveProjectSubdirectory(services, workspaceRoot);
  const cwd = projectScriptCwd({
    project: { cwd: workspaceRoot, repositorySubdirectory: subdirectory },
    worktreePath,
  });
  if (cwd === worktreePath) return cwd;
  const exists = yield* services.fileSystem.exists(cwd).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return yield* new ThreadWorkspaceFolderMissingError({
      worktreePath,
      subdirectory: subdirectory ?? "",
    });
  }
  return cwd;
});
