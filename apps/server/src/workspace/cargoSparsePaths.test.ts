import { describe, expect, it } from "vite-plus/test";

import { cargoSparsePaths } from "./cargoSparsePaths.ts";

const local = (name: string, dir: string, targets: ReadonlyArray<string> = ["src/lib.rs"]) => ({
  id: `path+file://${dir}#${name}`,
  source: null,
  manifest_path: `${dir}/Cargo.toml`,
  targets: targets.map((target) => ({ src_path: `${dir}/${target}` })),
});
const node = (
  id: string,
  deps: ReadonlyArray<readonly [string, ReadonlyArray<string | null>]>,
) => ({
  id,
  deps: deps.map(([pkg, kinds]) => ({ pkg, dep_kinds: kinds.map((kind) => ({ kind })) })),
});

const board = local("board", "/repo/crates/apps/board", ["src/main.rs", "build.rs"]);
const http = local("http", "/repo/crates/http");
const tls = local("tls", "/repo/crates/tls");
const testKit = local("test-kit", "/repo/crates/test-kit");
const fixtures = local("fixtures", "/repo/crates/fixtures");
const unrelated = local("unrelated", "/repo/crates/unrelated");
const patched = local("jsonwebtoken", "/repo/vendor/jsonwebtoken");
const serde = {
  id: "registry+https://github.com/rust-lang/crates.io-index#serde@1.0.0",
  source: "registry+https://github.com/rust-lang/crates.io-index",
  manifest_path: "/home/.cargo/registry/serde/Cargo.toml",
  targets: [{ src_path: "/home/.cargo/registry/serde/src/lib.rs" }],
};

const metadata = {
  packages: [board, http, tls, testKit, fixtures, unrelated, patched, serde],
  resolve: {
    nodes: [
      node(board.id, [
        [http.id, [null]],
        [testKit.id, ["dev"]],
        [serde.id, [null]],
      ]),
      node(http.id, [
        [tls.id, ["build"]],
        [fixtures.id, ["dev"]],
        [patched.id, [null, "dev"]],
      ]),
      node(tls.id, []),
      node(testKit.id, []),
      node(fixtures.id, []),
      node(unrelated.id, []),
      node(patched.id, []),
      node(serde.id, []),
    ],
  },
};

describe("cargoSparsePaths", () => {
  it("holds the crate's local build graph whole and every local package's manifest and targets", () => {
    const paths = cargoSparsePaths(metadata, "/repo/crates/apps/board/");
    expect([...(paths?.directories ?? [])].sort()).toEqual([
      "/repo/crates/apps/board",
      "/repo/crates/http",
      "/repo/crates/test-kit",
      "/repo/crates/tls",
      "/repo/vendor/jsonwebtoken",
    ]);
    expect(paths?.files).toContain("/repo/crates/unrelated/Cargo.toml");
    expect(paths?.files).toContain("/repo/crates/unrelated/src/lib.rs");
    expect(paths?.files).toContain("/repo/crates/apps/board/build.rs");
    expect(paths?.files).toContain("/repo/vendor/jsonwebtoken/Cargo.toml");
    expect(paths?.files).not.toContain("/home/.cargo/registry/serde/Cargo.toml");
  });

  it("matches a Windows folder whatever its separators and case", () => {
    const windows = {
      ...metadata,
      packages: metadata.packages.map((pkg) => ({
        ...pkg,
        manifest_path: pkg.manifest_path.replace("/repo", "C:\\repo").replaceAll("/", "\\"),
      })),
    };
    expect(cargoSparsePaths(windows, "c:/REPO/crates/apps/board")?.directories).toContain(
      "C:\\repo\\crates\\apps\\board",
    );
  });

  it("finds nothing outside a local crate", () => {
    expect(cargoSparsePaths(metadata, "/repo/crates")).toBeNull();
  });
});
