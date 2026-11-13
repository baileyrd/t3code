export type ToolCall =
  | { readonly tool: "read_file"; readonly path: string; readonly found: boolean }
  | { readonly tool: "list_dir"; readonly path: string }
  | { readonly tool: "search"; readonly path: string; readonly pattern: string }
  | { readonly tool: "run"; readonly command: string };

/**
 * `dependency`: the answer lives in a workspace dependency named by the note. `local`: it does
 * not. `outside`: it lives in `target`, in a crate a sparse worktree left out.
 */
export type Expectation =
  | { readonly kind: "dependency" | "local" }
  | { readonly kind: "outside"; readonly target: string };

const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

/**
 * A dependency case passes when the agent reads the named dependency without asking cargo for the
 * graph or searching the whole workspace first. A local case passes when it stays in its crate. An
 * outside case passes when it reads `target` after widening the checkout to it, without disabling it.
 */
export const grade = (
  input: Expectation & {
    readonly calls: ReadonlyArray<ToolCall>;
    readonly crateDir: string;
    readonly dependencyDirs: ReadonlyArray<string>;
  },
) => {
  const graphQuery = input.calls.find(
    (call) => call.tool === "run" && /cargo\s+(tree|metadata)/.test(call.command),
  );
  if (graphQuery) return { pass: false, reason: "asked cargo for the dependency graph" };
  if (input.kind === "outside") {
    const target = input.target;
    if (
      input.calls.some(
        (call) => call.tool === "run" && /sparse-checkout\s+disable\b/.test(call.command),
      )
    )
      return { pass: false, reason: "checked out the whole workspace" };
    return input.calls.some(
      (call) => call.tool === "read_file" && call.path === target && call.found,
    )
      ? { pass: true, reason: `read ${target}` }
      : { pass: false, reason: `never read ${target}` };
  }
  const outside = input.calls.flatMap((call) =>
    call.tool === "run" || within(call.path, input.crateDir) ? [] : [call.path],
  );
  if (input.kind === "local") {
    return outside.length === 0
      ? { pass: true, reason: "stayed in its crate" }
      : { pass: false, reason: `left its crate for ${outside[0]}` };
  }
  const first = outside[0];
  if (first === undefined) return { pass: false, reason: "never looked outside its crate" };
  return input.dependencyDirs.some((dir) => within(first, dir))
    ? { pass: true, reason: `went straight to ${first}` }
    : { pass: false, reason: `looked at ${first} before the named dependency` };
};
