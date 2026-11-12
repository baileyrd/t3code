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

  it.each([
    ["one level", "/repo", ["/repo/crates/tokio", "/repo/crates/tokio/macros"], "crates/tokio"],
    [
      "three levels",
      "/repo",
      ["/repo/crates/d", "/repo/crates/d/a/n1", "/repo/crates/d/a/n1/b/n2"],
      "crates/d",
    ],
    [
      "two Windows spellings",
      "C:/Dev/Repo",
      ["C:\\Dev\\Repo\\Crates\\Tokio", "c:\\dev\\repo\\crates\\tokio\\macros"],
      "Crates/Tokio",
    ],
  ] as const)(
    "never cuts out the subfolders of a folder that holds another, at %s",
    (_name, root, directories, whole) => {
      const patterns = sparseCheckoutPatterns(root, { directories, files: [] }) ?? [];
      expect(patterns).toContain(`/${whole}/`);
      const folded = whole.toLowerCase();
      const cutting = patterns.filter((pattern) => {
        const lower = pattern.toLowerCase();
        return lower.startsWith(`!/${folded}/`) || lower === `/${folded}/*`;
      });
      expect(cutting).toEqual([]);
      expect(patterns.filter((pattern) => pattern.toLowerCase() === "/crates/*")).toHaveLength(1);
    },
  );

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
