/**
 * decktective — omp extension entry.
 *
 * This is the module omp loads: a default-exported factory that registers a
 * `decktective` tool (so the model can call it directly) and a `/deck` command
 * (for explicit use). The heavy lifting lives in `src/`, which is plain Node
 * TypeScript — this file is only the adapter.
 *
 * Everything it needs is resolved from THIS package's own root, so the package
 * is self-contained: no project path, no clone, no machine-specific config.
 *
 * Deliberately outside `src/`, so it is excluded from the project's tsconfig:
 * `@oh-my-pi/pi-coding-agent` is a host-provided import, resolved by omp at load
 * time, and is not installed here as a dependency.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { findPackageRoot } from "../src/package-root.ts";

/** Package root, derived from this module — never from cwd. */
const PACKAGE_ROOT = findPackageRoot();
/**
 * The COMPILED CLI. Node refuses to type-strip files under node_modules, so an
 * installed package must run emitted JavaScript — shipping `.ts` works only in
 * a checkout, which is exactly the bug that shipped in 0.1.0.
 */
const CLI = resolve(PACKAGE_ROOT, "dist", "src", "cli.js");
const TEMPLATE = resolve(PACKAGE_ROOT, "templates", "template1.pptx");

type RunResult = { code: number; stdout: string; stderr: string };

/**
 * Run the CLI and capture output.
 *
 * `spawn` with an argv array rather than a shell string: repository URLs, paths
 * and titles come from a model and must never be interpreted by a shell.
 */
function runCli(args: string[], signal?: AbortSignal): Promise<RunResult> {
  const { promise, resolve } = Promise.withResolvers<RunResult>();
  const child = spawn("node", [CLI, ...args], {
    cwd: PACKAGE_ROOT,
    ...(signal ? { signal } : {}),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  child.on("error", (err: Error) => resolve({ code: 1, stdout, stderr: err.message }));
  child.on("close", (code: number | null) => resolve({ code: code ?? 1, stdout, stderr }));
  return promise;
}

type DeckParams = {
  repo: string;
  start?: string;
  end?: string;
  preset?: string;
  out?: string;
  title?: string;
  template?: string;
  tz?: string;
  offline?: boolean;
  llm?: string;
};

/** Build the CLI argv from typed parameters. */
function buildArgs(params: DeckParams): string[] {
  const args = ["--repo", params.repo, "--out", params.out ?? "out", "-y"];
  if (params.start !== undefined) args.push("--start", params.start);
  if (params.end !== undefined) args.push("--end", params.end);
  if (params.preset !== undefined) args.push("--preset", params.preset);
  if (params.title !== undefined) args.push("--title", params.title);
  if (params.tz !== undefined) args.push("--tz", params.tz);
  if (params.template !== undefined) {
    args.push("--pptx-template", params.template === "served" ? TEMPLATE : params.template);
  }
  if (params.offline === true) args.push("--offline");
  if (params.llm !== undefined) args.push("--llm", params.llm);
  return args;
}

export default function decktective(pi: {
  setLabel(label: string): void;
  registerTool(def: Record<string, unknown>): void;
  registerCommand(name: string, def: Record<string, unknown>): void;
  zod: { object(shape: Record<string, unknown>): unknown; string(): unknown; boolean(): unknown };
}) {
  pi.setLabel("Decktective");

  pi.registerTool({
    name: "decktective",
    label: "Build weekly deck",
    description:
      "Build a weekly activity deck (PPTX) from a git repository, filling a .pptx " +
      "template. Provide the repo (URL, owner/repo, or local path) and either a " +
      "--preset like 'this'/'last' or explicit ISO start/end instants WITH an offset. " +
      "Returns the path of the generated deck.",
    parameters: pi.zod.object({
      repo: pi.zod.string(),
      preset: pi.zod.string(),
      start: pi.zod.string(),
      end: pi.zod.string(),
      out: pi.zod.string(),
      title: pi.zod.string(),
      template: pi.zod.string(),
      tz: pi.zod.string(),
      offline: pi.zod.boolean(),
      llm: pi.zod.string(),
    }),
    async execute(
      _toolCallId: string,
      params: DeckParams,
      signal?: AbortSignal,
    ): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
      const result = await runCli(buildArgs(params), signal);
      const ok = result.code === 0;
      const text = ok
        ? result.stdout.trim() || "deck built"
        : `decktective failed (exit ${result.code}):\n${result.stderr.trim() || result.stdout.trim()}`;
      return {
        content: [{ type: "text", text }],
        details: { exitCode: result.code, args: buildArgs(params) },
      };
    },
  });

  pi.registerCommand("deck", {
    description: "Build a weekly deck. Usage: /deck <repo> [--preset this|last] [--offline]",
    handler: async (args: string, ctx: { ui: { notify(message: string, level?: string): void } }) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        ctx.ui.notify("Usage: /deck <repo> [--preset this|last] [--offline]", "info");
        return;
      }
      const [repo, ...rest] = parts as [string, ...string[]];
      const presetIdx = rest.indexOf("--preset");
      const params: DeckParams = {
        repo,
        out: "out",
        preset: presetIdx >= 0 ? rest[presetIdx + 1] : "this",
        ...(rest.includes("--offline") ? { offline: true } : {}),
        template: "served",
      };
      const result = await runCli(buildArgs(params));
      ctx.ui.notify(result.code === 0 ? result.stdout.trim() : `failed: ${result.stderr.trim()}`, "info");
    },
  });
}
