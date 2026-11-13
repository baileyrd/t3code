export type ToolCall =
  | { readonly tool: "read_file" | "list_dir"; readonly path: string }
  | { readonly tool: "search"; readonly path: string; readonly pattern: string }
  | { readonly tool: "run"; readonly command: string };

const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

/**
 * A dependency case passes when the agent reads the named dependency without asking cargo for the
 * graph or searching the whole workspace first. A local case passes when it stays in its crate. An
 * outside case passes when it widens the sparse checkout.
 */
export const grade = (input: {
  readonly kind: "dependency" | "local" | "outside";
  readonly calls: ReadonlyArray<ToolCall>;
  readonly crateDir: string;
  readonly dependencyDirs: ReadonlyArray<string>;
}) => {
  const graphQuery = input.calls.find(
    (call) => call.tool === "run" && /cargo\s+(tree|metadata)/.test(call.command),
  );
  if (graphQuery) return { pass: false, reason: "asked cargo for the dependency graph" };
  if (input.kind === "outside") {
    const widen = input.calls.flatMap((call) =>
      call.tool === "run" && /git\s+sparse-checkout\s+(add|disable)\b/.test(call.command)
        ? [call.command]
        : [],
    )[0];
    return widen === undefined
      ? { pass: false, reason: "never widened the sparse checkout" }
      : { pass: true, reason: `widened with \`${widen}\`` };
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
