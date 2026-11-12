import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import type * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

/**
 * Where a thread works. A worktree thread of a project below its repository root works in the
 * same folder inside its worktree, or the worktree root when that folder is missing there.
 */
export const resolveThreadWorkspaceCwd = Effect.fn("resolveThreadWorkspaceCwd")(function* (
  services: {
    readonly vcs: VcsDriverRegistry.VcsDriverRegistry["Service"];
    readonly fileSystem: FileSystem.FileSystem;
  },
  input: { readonly workspaceRoot: string; readonly worktreePath: string | null },
) {
  const { worktreePath, workspaceRoot } = input;
  if (worktreePath === null) return workspaceRoot;
  const repositoryRoot = yield* services.vcs.detect({ cwd: workspaceRoot }).pipe(
    Effect.map((handle) => handle?.repository.rootPath ?? null),
    Effect.orElseSucceed(() => null),
  );
  if (repositoryRoot === null) return worktreePath;
  // Git reports a physical root, so compare it with the physical project folder.
  const physicalRoot = yield* services.fileSystem
    .realPath(workspaceRoot)
    .pipe(Effect.orElseSucceed(() => workspaceRoot));
  const cwd = projectScriptCwd({
    project: { cwd: physicalRoot, repositoryRoot },
    worktreePath,
  });
  if (cwd === worktreePath) return cwd;
  const exists = yield* services.fileSystem.exists(cwd).pipe(Effect.orElseSucceed(() => false));
  return exists ? cwd : worktreePath;
});
