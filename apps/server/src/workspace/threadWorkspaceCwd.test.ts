import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  resolveProjectSubdirectory,
  resolveThreadWorkspaceCwd,
  ThreadWorkspaceFolderMissingError,
} from "./threadWorkspaceCwd.ts";

const layer = VcsDriverRegistry.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const gitInit = (directory: string) =>
  Effect.gen(function* () {
    const vcs = yield* VcsProcess.VcsProcess;
    return yield* vcs.run({
      operation: "test.git-init",
      command: "git",
      args: ["init", "--quiet", directory],
      cwd: directory,
    });
  });

/** A git repository with `crates/mill`, reached through a symlink as users often open it. */
const makeRepository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-cwd-" });
  const repository = path.join(base, "repository");
  yield* fileSystem.makeDirectory(path.join(repository, "crates", "mill"), { recursive: true });
  yield* gitInit(repository);
  const linked = path.join(base, "linked");
  yield* fileSystem.symlink(repository, linked);
  const services = { vcs: yield* VcsDriverRegistry.VcsDriverRegistry, fileSystem };
  return { base, path, fileSystem, services, workspaceRoot: path.join(linked, "crates", "mill") };
});

it.live("finds the subfolder of a project opened through a symlink", () =>
  Effect.gen(function* () {
    const { services, workspaceRoot, base, path } = yield* makeRepository;

    assert.equal(yield* resolveProjectSubdirectory(services, workspaceRoot), "crates/mill");
    assert.equal(yield* resolveProjectSubdirectory(services, path.join(base, "linked")), "");
    assert.isNull(yield* resolveProjectSubdirectory(services, base));
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("works in the project's folder inside the worktree, and fails when it is missing", () =>
  Effect.gen(function* () {
    const { services, workspaceRoot, base, path, fileSystem } = yield* makeRepository;
    const worktreePath = path.join(base, "worktree");
    yield* fileSystem.makeDirectory(worktreePath);

    const missing = yield* resolveThreadWorkspaceCwd(services, {
      workspaceRoot,
      worktreePath,
    }).pipe(Effect.flip);
    assert.instanceOf(missing, ThreadWorkspaceFolderMissingError);

    yield* fileSystem.makeDirectory(path.join(worktreePath, "crates", "mill"), { recursive: true });
    assert.equal(
      yield* resolveThreadWorkspaceCwd(services, { workspaceRoot, worktreePath }),
      path.join(worktreePath, "crates", "mill"),
    );
    assert.equal(
      yield* resolveThreadWorkspaceCwd(services, { workspaceRoot, worktreePath: null }),
      workspaceRoot,
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
