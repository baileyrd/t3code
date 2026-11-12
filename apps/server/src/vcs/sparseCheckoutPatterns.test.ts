import { describe, expect, it } from "vite-plus/test";

import { sparseCheckoutPatterns } from "./sparseCheckoutPatterns.ts";

describe("sparseCheckoutPatterns", () => {
  it("includes root files, ancestors' files and .cargo folders, folders, then single files", () => {
    expect(
      sparseCheckoutPatterns("/repo", {
        directories: ["/repo/crates/apps/board", "/repo/crates/http/", "/elsewhere/crate"],
        files: ["/repo/crates/unrelated/Cargo.toml", "/repo"],
      }),
    ).toEqual([
      "/*",
      "!/*/",
      "/.cargo/",
      "/crates/*",
      "!/crates/*/",
      "/crates/.cargo/",
      "/crates/apps/*",
      "!/crates/apps/*/",
      "/crates/apps/.cargo/",
      "/crates/apps/board/",
      "/crates/http/",
      "/crates/unrelated/Cargo.toml",
    ]);
  });

  it("relates Windows paths whatever their separators and case, keeping the paths' case", () => {
    expect(
      sparseCheckoutPatterns("C:/Dev/Repo", {
        directories: ["c:\\dev\\repo\\Crates\\Board"],
        files: [],
      }),
    ).toContain("/Crates/Board/");
  });

  it("gives up when the project's folder is outside the repository as spelled", () => {
    expect(
      sparseCheckoutPatterns("/var/repo", {
        directories: ["/private/var/repo/crates/mill", "/var/repo/crates/http"],
        files: [],
      }),
    ).toBeNull();
  });

  it("escapes characters that are patterns in gitignore syntax", () => {
    expect(sparseCheckoutPatterns("/repo", { directories: ["/repo/a[1]*?"], files: [] })).toContain(
      "/a\\[1\\]\\*\\?/",
    );
  });
});
