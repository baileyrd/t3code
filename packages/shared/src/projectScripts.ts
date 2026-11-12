import type { ProjectId, ProjectScript, ServerSettings } from "@t3tools/contracts";

type ProjectScriptSettings = Pick<
  ServerSettings,
  | "defaultProjectScripts"
  | "projectScriptOverrides"
  | "projectSettingsOverrides"
  | "projectSettingsFolded"
>;

export function resolveProjectScripts(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): readonly ProjectScript[] {
  const override = settings.projectSettingsOverrides[project.id]?.defaultProjectScripts;
  if (override !== undefined) return override;
  if (settings.projectSettingsFolded) return settings.defaultProjectScripts;
  const legacy = settings.projectScriptOverrides[project.id];
  if (legacy === null) return settings.defaultProjectScripts;
  return legacy ?? (project.scripts.length > 0 ? project.scripts : settings.defaultProjectScripts);
}

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

const WINDOWS_PATH = /^(?:[a-zA-Z]:|[\\/]{2})/;

/**
 * The project's folder below its repository root, `/`-separated; "" at the root, outside it, or
 * when unknown. Git prints `C:/repo` for `C:\repo`, so Windows paths compare by `/` and case.
 */
export function projectSubdirectory(
  repositoryRoot: string | null | undefined,
  workspaceRoot: string,
): string {
  if (!repositoryRoot) return "";
  const windows = WINDOWS_PATH.test(repositoryRoot) || WINDOWS_PATH.test(workspaceRoot);
  const normalize = (path: string) => {
    const slashed = windows ? path.replaceAll("\\", "/") : path;
    return slashed.replace(/\/+$/, "");
  };
  const root = normalize(repositoryRoot);
  const workspace = normalize(workspaceRoot);
  const prefix = `${root}/`;
  const inside = windows
    ? workspace.toLowerCase().startsWith(prefix.toLowerCase())
    : workspace.startsWith(prefix);
  if (!inside) return "";
  const segments = workspace
    .slice(prefix.length)
    .split("/")
    .filter((segment) => segment !== "");
  return segments.some((segment) => segment === "." || segment === "..") ? "" : segments.join("/");
}

/**
 * Where a thread works: the project folder, or the project's repository subdirectory inside the
 * thread's worktree. The server publishes `repositorySubdirectory`; unknown means the worktree root.
 */
export function projectScriptCwd(input: {
  project: {
    cwd: string;
    repositorySubdirectory?: string | null | undefined;
  };
  worktreePath?: string | null;
}): string {
  const { worktreePath } = input;
  if (worktreePath == null) return input.project.cwd;
  const subdirectory = input.project.repositorySubdirectory ?? "";
  if (subdirectory === "") return worktreePath;
  const separator = worktreePath.includes("\\") && !worktreePath.includes("/") ? "\\" : "/";
  return `${worktreePath.replace(/[\\/]+$/, "")}${separator}${subdirectory.replaceAll("/", separator)}`;
}

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {
    T3CODE_PROJECT_ROOT: input.project.cwd,
  };
  if (input.worktreePath) {
    env.T3CODE_WORKTREE_PATH = input.worktreePath;
  }
  if (input.extraEnv) {
    return { ...env, ...input.extraEnv };
  }
  return env;
}

export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}

export function projectScriptMenuLabel(script: ProjectScript): string {
  const roles = [
    ...(script.runOnWorktreeCreate ? ["setup"] : []),
    ...(script.runOnSettle ? ["on settle"] : []),
  ];
  return roles.length === 0 ? script.name : `${script.name} (${roles.join(", ")})`;
}

export function settleProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnSettle === true) ?? null;
}

/**
 * Leading spaces omit scripts from Bash history with ignorespace/ignoreboth,
 * zsh with HIST_IGNORE_SPACE, and fish. Only the first line is prefixed, so later
 * entries from multiline input may still enter history. PowerShell/PSReadLine history is not suppressed.
 */
export function projectScriptTerminalInput(command: string): string {
  return ` ${command}\r`;
}
