#!/usr/bin/env node
// An eval script, not server code: it writes results with node:fs.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { withInlineContext } from "../../apps/server/src/orchestration-v2/ContextHandoffDelivery.ts";
import { workspaceCrateNoteText } from "../../apps/server/src/workspace/workspaceCrateNote.ts";
import { proxyConfig } from "../shared/proxy.ts";
import { cases, crateDir, files, note, workspaceRoot, type Case } from "./cases.ts";
import { grade, type ToolCall } from "./grade.ts";
import { simulateRun, sparseStart, sparseVisible } from "./sandbox.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", multiple: true },
    case: { type: "string", multiple: true },
    note: { type: "string", default: "current" },
    sparse: { type: "boolean", default: false },
    samples: { type: "string", default: "3" },
    concurrency: { type: "string", default: "6" },
  },
});
if (!values.out)
  throw new Error("Use --out <directory> [--model <id>] [--note current|plain|none] [--sparse].");
if (values.note !== "current" && values.note !== "plain" && values.note !== "none")
  throw new Error("--note is current, plain or none.");
const sparse = values.sparse === true;
const outDirectory = values.out;
const models = values.model ?? ["gpt-6.1-terra", "gpt-6-luna"];
// Outside cases need a sparse worktree; without one there is nothing to widen.
const runnable = cases.filter((entry) => sparse || entry.kind !== "outside");
const missing = (values.case ?? []).filter((id) => !runnable.some((entry) => entry.id === id));
if (missing.length > 0)
  throw new Error(`No such case${sparse ? "" : " without --sparse"}: ${missing.join(", ")}.`);
const selected = values.case
  ? runnable.filter((entry) => values.case!.includes(entry.id))
  : runnable;
// `plain` is the note before sparse worktrees told the agent how to widen one.
const noteText =
  values.note === "none" ? "" : workspaceCrateNoteText(note, sparse && values.note === "current");
const dependencyDirs = note.dependencies.map((name) => `${workspaceRoot}/crates/${name}`);
const proxy = proxyConfig();

const fullTree = new Map(
  Object.entries(files).map(([path, text]) => [`${workspaceRoot}/${path}`, text]),
);
const resolve = (path: unknown) => NodePath.posix.resolve(crateDir, String(path ?? "."));

/** The files a sample sees; a sparse one grows as `run` widens it. */
const makeTree = () => {
  const checkout = sparseStart();
  const visible = () =>
    new Map(
      [...fullTree].filter(
        ([file]) => !sparse || sparseVisible(file.slice(workspaceRoot.length + 1), checkout),
      ),
    );
  return { visible, run: (command: string) => simulateRun(command, checkout) };
};

const listDir = (tree: ReadonlyMap<string, string>, dir: string) => {
  const names = new Set<string>();
  for (const file of tree.keys()) {
    if (file.startsWith(`${dir}/`)) {
      const [head, ...rest] = file.slice(dir.length + 1).split("/");
      names.add(rest.length > 0 ? `${head}/` : head!);
    }
  }
  return names.size === 0 ? "No such directory." : [...names].toSorted().join("\n");
};

const search = (tree: ReadonlyMap<string, string>, dir: string, pattern: string) => {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return "Invalid regular expression.";
  }
  const hits = [...tree]
    .filter(([file]) => file.startsWith(`${dir}/`))
    .flatMap(([file, text]) =>
      text
        .split("\n")
        .flatMap((line, index) => (regex.test(line) ? [`${file}:${index + 1}: ${line}`] : [])),
    );
  return hits.join("\n") || "No matches.";
};

const tools = [
  {
    type: "function",
    name: "read_file",
    description: "Read a file. Relative paths start at the working directory.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    type: "function",
    name: "list_dir",
    description: "List a directory. Relative paths start at the working directory.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    type: "function",
    name: "search",
    description: "Search files under a directory with a regular expression.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern", "path"],
    },
  },
  {
    type: "function",
    name: "run",
    description: "Run a shell command in the working directory.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

const instructions = [
  "You are a coding agent working in a user's repository. Use the tools to look around before you answer.",
  `Your working directory is ${crateDir}.`,
  "Do not edit files: reply with the change you would make, as a diff, once you have read what you need.",
].join("\n");

const decodeResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      output: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
      usage: Schema.optional(Schema.Struct({ total_tokens: Schema.optional(Schema.Number) })),
    }),
  ),
);
const decodeArguments = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeRow = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const post = Effect.fn("evaluateCrateNote.post")(function* (body: unknown) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.retryTransient({
      retryOn: "errors-and-responses",
      schedule: Schedule.exponential("2 seconds"),
      times: 4,
    }),
  );
  const response = yield* HttpClientRequest.post(`${proxy.url}/responses`).pipe(
    HttpClientRequest.setHeaders(proxy.headers),
    HttpClientRequest.bodyJson(body),
    Effect.flatMap(client.execute),
  );
  const text = yield* response.text;
  if (response.status !== 200)
    return yield* Effect.die(new Error(`Model API ${response.status}: ${text}`));
  return decodeResponse(text);
});

const runSample = Effect.fn("evaluateCrateNote.sample")(function* (entry: Case, model: string) {
  const calls: Array<ToolCall> = [];
  const sampleTree = makeTree();
  const input: Array<unknown> = [
    { role: "user", content: withInlineContext(noteText, entry.task) },
  ];
  let tokens = 0;
  for (let step = 0; step < 12; step++) {
    const response = yield* post({ model, instructions, input, tools, store: false });
    tokens += response.usage?.total_tokens ?? 0;
    input.push(...response.output);
    const pending = response.output.filter((item) => item.type === "function_call");
    if (pending.length === 0) break;
    for (const call of pending) {
      const args = decodeArguments(String(call.arguments));
      let output: string;
      const tree = sampleTree.visible();
      if (call.name === "run") {
        calls.push({ tool: "run", command: String(args.command) });
        output =
          sampleTree.run(String(args.command)) ??
          "This sandbox has no Rust toolchain; use the file tools.";
      } else if (call.name === "search") {
        const path = resolve(args.path);
        calls.push({ tool: "search", path, pattern: String(args.pattern) });
        output = search(tree, path, String(args.pattern));
      } else if (call.name === "list_dir") {
        const path = resolve(args.path);
        calls.push({ tool: "list_dir", path });
        output = listDir(tree, path);
      } else {
        const path = resolve(args.path);
        const text = tree.get(path);
        calls.push({ tool: "read_file", path, found: text !== undefined });
        output = text ?? "File not found.";
      }
      input.push({ type: "function_call_output", call_id: call.call_id, output });
    }
  }
  return { ...grade({ ...entry, calls, crateDir, dependencyDirs }), calls, tokens };
});

const sampleSafely = (entry: Case, model: string, sample: number) =>
  runSample(entry, model).pipe(
    Effect.map((result) => ({ case: entry.id, model, sample, ...result })),
    Effect.catchCause((cause) =>
      Effect.succeed({ case: entry.id, model, sample, error: String(cause) }),
    ),
  );

type Row = Effect.Success<ReturnType<typeof sampleSafely>>;
const passed = (row: Row) => "pass" in row && row.pass;

const summary = await Effect.runPromise(
  Effect.gen(function* () {
    NodeFS.mkdirSync(outDirectory, { recursive: true });
    const jobs = models.flatMap((model) =>
      selected.flatMap((entry) =>
        Array.from({ length: Number(values.samples) }, (_, n) => ({ model, entry, n })),
      ),
    );
    const rows = yield* Effect.forEach(
      jobs,
      ({ model, entry, n }) => sampleSafely(entry, model, n),
      {
        concurrency: Number(values.concurrency),
      },
    );
    NodeFS.writeFileSync(
      NodePath.join(outDirectory, "results.ndjson"),
      rows.map((row) => encodeRow(row)).join("\n") + "\n",
    );
    const lines = [
      `note: ${values.note}${sparse ? ", sparse worktree" : ""}`,
      "",
      "| model | case | passed | failed to run | tokens |",
      "|---|---|---|---|---|",
    ];
    for (const model of models) {
      for (const entry of selected) {
        const own = rows.filter((row) => row.model === model && row.case === entry.id);
        const tokens = own.reduce((sum, row) => sum + ("tokens" in row ? row.tokens : 0), 0);
        lines.push(
          `| ${model} | ${entry.id} | ${own.filter(passed).length}/${own.length} | ${own.filter((row) => "error" in row).length} | ${tokens} |`,
        );
      }
    }
    const firstError = rows.find((row) => "error" in row);
    if (firstError !== undefined && "error" in firstError) {
      lines.push("", `First error: ${firstError.error.split("\n")[0]}`);
    }
    const report = lines.join("\n") + "\n";
    NodeFS.writeFileSync(NodePath.join(outDirectory, "summary.md"), report);
    return report;
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
process.stdout.write(summary);
