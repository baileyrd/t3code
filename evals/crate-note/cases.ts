import type { Expectation } from "./grade.ts";

/**
 * Tasks given to an agent on a thread's first turn in a member crate of a Cargo workspace. The
 * workspace is the same small tree for every case; `kind` says what a good first move looks like.
 */
export type Case = Expectation & {
  readonly id: string;
  readonly source: string;
  readonly task: string;
};

export const workspaceRoot = "/home/user/app";
export const crateDir = `${workspaceRoot}/crates/mill`;
export const note = { crate: "mill", dependencies: ["rustils"] } as const;

const decoy = (name: string) => ({
  [`crates/${name}/Cargo.toml`]: `[package]\nname = "${name}"\nversion = "0.1.0"\n`,
  [`crates/${name}/src/lib.rs`]: `//! ${name}\npub fn run() {}\n`,
});

/** The workspace, by path from its root. */
export const files: Readonly<Record<string, string>> = {
  "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\nresolver = "2"\n',
  "crates/mill/Cargo.toml":
    '[package]\nname = "mill"\nversion = "0.1.0"\n\n[dependencies]\nrustils = { path = "../rustils" }\n',
  "crates/mill/src/lib.rs": "pub mod retry;\n",
  "crates/mill/src/retry.rs": [
    "use std::{thread, time::Duration};",
    "",
    "/// Runs `op` up to `attempts` times, sleeping between tries.",
    "pub fn retry<T, E>(attempts: u32, mut op: impl FnMut() -> Result<T, E>) -> Result<T, E> {",
    "    let mut tries = 0;",
    "    loop {",
    "        match op() {",
    "            Ok(value) => return Ok(value),",
    "            Err(error) if tries + 1 >= attempts => return Err(error),",
    "            Err(_) => {",
    "                tries += 1;",
    "                thread::sleep(Duration::from_millis(100));",
    "            }",
    "        }",
    "    }",
    "}",
    "",
  ].join("\n"),
  "crates/rustils/Cargo.toml": '[package]\nname = "rustils"\nversion = "0.1.0"\n',
  "crates/rustils/src/lib.rs": "pub mod backoff;\n",
  "crates/rustils/src/backoff.rs": [
    "use std::time::Duration;",
    "",
    "/// Delay before retry number `attempt` (0-based): 50ms doubling, capped at 5s.",
    "pub fn backoff_delay(attempt: u32) -> Duration {",
    "    Duration::from_millis(50u64.saturating_mul(1 << attempt.min(7))).min(Duration::from_secs(5))",
    "}",
    "",
  ].join("\n"),
  "crates/telemetry/Cargo.toml": '[package]\nname = "telemetry"\nversion = "0.1.0"\n',
  "crates/telemetry/src/lib.rs": "pub mod metrics;\n",
  "crates/telemetry/src/metrics.rs": [
    "/// Adds one to the counter `name`, tagged with `labels`.",
    "pub fn increment(name: &'static str, labels: &[(&'static str, String)]) {",
    "    let _ = (name, labels);",
    "}",
    "",
  ].join("\n"),
  ...decoy("netkit"),
  ...decoy("store"),
  ...decoy("cli"),
};

export const cases: ReadonlyArray<Case> = [
  {
    id: "backoff-from-dependency",
    kind: "dependency",
    source:
      "baileyrd/t3code#2: the note exists so the agent finds workspace code without `cargo tree`",
    task: "The fixed 100ms sleep in retry.rs hammers servers. Use the workspace's existing backoff helper instead of writing a new one.",
  },
  {
    id: "local-attempt-count",
    kind: "local",
    source: "control: a task inside the crate should not send the agent into its dependencies",
    task: "Add a doc example to `retry` in retry.rs showing a call that succeeds on the second try.",
  },
  {
    id: "metric-from-sparse-crate",
    kind: "outside",
    target: `${workspaceRoot}/crates/telemetry/src/metrics.rs`,
    source:
      "baileyrd/t3code#7: a sparse worktree holds only the crate's build graph, so other crates must be added first",
    task: "Count each retry in retry.rs with the workspace's telemetry crate. Look up its metrics API first.",
  },
];
