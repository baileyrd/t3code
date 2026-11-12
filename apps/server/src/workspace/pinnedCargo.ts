import { isCommandMissingCause } from "@t3tools/provider-core/server/snapshotProbe";
import * as Clock from "effect/Clock";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

import type * as ProcessRunner from "../processRunner.ts";

// A toolchain name, never a path: `RUSTUP_TOOLCHAIN=/dir` would run that folder's `bin/cargo`.
const TOOLCHAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const TOOLCHAIN_TTL_MS = 5 * 60 * 1000;
// Pinned when rustup is missing: a lone rustup `cargo` shim still proxies, and refuses this name;
// a non-rustup cargo ignores the variable.
const NO_RUSTUP_TOOLCHAIN = "t3code-no-toolchain";

interface PinnedCargoServices {
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
  readonly path: Path.Path;
}

export interface PinnedCargoRun {
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly timeout: Duration.Input;
  readonly maxOutputBytes: number;
}

/**
 * Runs cargo inside a repository without obeying its `rust-toolchain(.toml)`. `cargo` is usually
 * a rustup proxy that follows that file, which can name a folder whose `bin/cargo` it then runs;
 * pinning `RUSTUP_TOOLCHAIN` to the user's default overrides every such file.
 *
 * `run` yields cargo's stdout, or null when there is no safe toolchain or cargo fails.
 */
export function makePinnedCargo(services: PinnedCargoServices) {
  const { path } = services;
  const rootOf = (dir: string): string =>
    path.dirname(dir) === dir ? dir : rootOf(path.dirname(dir));

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

  // Kept for a few minutes, and dropped when cargo fails in case it was switched or uninstalled.
  let cachedToolchain: { readonly name: string | null; readonly at: number } | undefined;
  const resolveToolchain = Effect.fn("PinnedCargo.resolveToolchain")(function* (cwd: string) {
    const now = yield* Clock.currentTimeMillis;
    if (cachedToolchain !== undefined && now - cachedToolchain.at < TOOLCHAIN_TTL_MS) {
      return cachedToolchain.name;
    }
    // Read outside any repository, so no toolchain file can answer for the user's default.
    const resolved = yield* readDefaultToolchain(rootOf(cwd));
    if (Option.isNone(resolved)) return null;
    cachedToolchain = { name: resolved.value, at: now };
    return resolved.value;
  });

  const run = Effect.fn("PinnedCargo.run")(function* (input: PinnedCargoRun) {
    const toolchain = yield* resolveToolchain(input.cwd);
    if (toolchain === null) return null;
    const output = yield* services.processRunner
      .run({
        command: "cargo",
        args: input.args,
        cwd: input.cwd,
        env: { RUSTUP_TOOLCHAIN: toolchain, RUSTUP_AUTO_INSTALL: "0" },
        timeout: input.timeout,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: input.maxOutputBytes,
      })
      .pipe(Effect.option);
    if (output._tag === "Some" && output.value.code === 0 && !output.value.timedOut) {
      return output.value.stdout;
    }
    cachedToolchain = undefined;
    return null;
  });

  return { run };
}
