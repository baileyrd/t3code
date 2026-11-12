import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const FILESYSTEM_PATH_MAX_LENGTH = 512;

export const FILESYSTEM_METADATA_BATCH_LIMIT = 64;

export const FilesystemGetMetadataInput = Schema.Struct({
  // Absolute host paths, including ~/; clients must anchor relative paths.
  paths: Schema.Array(
    TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(FILESYSTEM_METADATA_BATCH_LIMIT)),
});
export type FilesystemGetMetadataInput = typeof FilesystemGetMetadataInput.Type;

export const FilesystemEntryMetadata = Schema.Struct({
  kind: Schema.Literals(["file", "directory", "other"]),
  byteLength: Schema.optionalKey(NonNegativeInt),
  mimeType: Schema.optionalKey(TrimmedNonEmptyString),
});
export type FilesystemEntryMetadata = typeof FilesystemEntryMetadata.Type;

// Entries follow request order; null means missing, unreadable, or unsupported.
export const FilesystemGetMetadataResult = Schema.Struct({
  entries: Schema.Array(Schema.NullOr(FilesystemEntryMetadata)),
});
export type FilesystemGetMetadataResult = typeof FilesystemGetMetadataResult.Type;

export const FilesystemBrowseInput = Schema.Struct({
  partialPath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  cwd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH))),
});
export type FilesystemBrowseInput = typeof FilesystemBrowseInput.Type;

export const FilesystemBrowseEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  fullPath: TrimmedNonEmptyString,
});
export type FilesystemBrowseEntry = typeof FilesystemBrowseEntry.Type;

export const FilesystemBrowseResult = Schema.Struct({
  parentPath: TrimmedNonEmptyString,
  entries: Schema.Array(FilesystemBrowseEntry),
});
export type FilesystemBrowseResult = typeof FilesystemBrowseResult.Type;

export const FilesystemWorkspacePackagesInput = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
});
export type FilesystemWorkspacePackagesInput = typeof FilesystemWorkspacePackagesInput.Type;

export const FilesystemWorkspacePackage = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** From the workspace root, with `/` separators. */
  relativePath: TrimmedNonEmptyString,
  fullPath: TrimmedNonEmptyString,
});
export type FilesystemWorkspacePackage = typeof FilesystemWorkspacePackage.Type;

export const FilesystemWorkspacePackagesResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    packages: Schema.Array(FilesystemWorkspacePackage),
  }),
  Schema.Struct({ status: Schema.Literal("not-workspace") }),
  // A workspace whose packages could not be listed: cargo missing, failing, or too slow.
  Schema.Struct({ status: Schema.Literal("failed"), reason: TrimmedNonEmptyString }),
]);
export type FilesystemWorkspacePackagesResult = typeof FilesystemWorkspacePackagesResult.Type;

export const FilesystemBrowseFailure = Schema.Literals([
  "windows_path_unsupported",
  "current_project_required",
  "read_directory_failed",
]);
export type FilesystemBrowseFailure = typeof FilesystemBrowseFailure.Type;

function decodedFilesystemBrowseErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class FilesystemBrowseError extends Schema.TaggedError<FilesystemBrowseError>()(
  "FilesystemBrowseError",
  {
    partialPath: Schema.optional(TrimmedNonEmptyString),
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(FilesystemBrowseFailure),
    parentPath: Schema.optional(TrimmedNonEmptyString),
    platform: Schema.optional(TrimmedNonEmptyString),
    /** Set when the directory does not exist; older clients ignore it. */
    pathMissing: Schema.optional(Schema.Boolean),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly partialPath: string;
    readonly cwd?: string | undefined;
    readonly failure: FilesystemBrowseFailure;
    readonly parentPath?: string;
    readonly platform?: string;
    readonly pathMissing?: boolean;
    readonly cause?: unknown;
  }) {
    const cwd = props.cwd === undefined ? "" : ` from '${props.cwd}'`;
    super({
      ...props,
      message:
        decodedFilesystemBrowseErrorMessage(props) ??
        `Failed to browse filesystem path '${props.partialPath}'${cwd}.`,
    } as any);
  }
}
