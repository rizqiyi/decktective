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
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { findPackageRoot } from "../src/package-root.js";
/** Package root, derived from this module — never from cwd. */
const PACKAGE_ROOT = findPackageRoot();
/**
 * The CLI to spawn, and the runtime to spawn it with.
 *
 * Node refuses to type-strip inside node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING),
 * so an npm install must run the COMPILED CLI — shipping `.ts` only works in a
 * checkout, which is the bug that shipped in 0.1.0. A git or local install may
 * have no build output, so fall back to the source plus Bun, which type-strips
 * anywhere. Node cannot run the fallback.
 */
const DIST_CLI = resolve(PACKAGE_ROOT, "dist", "src", "cli.js");
const SRC_CLI = resolve(PACKAGE_ROOT, "src", "cli.ts");
const useDist = existsSync(DIST_CLI);
const RUNTIME = useDist ? "node" : "bun";
const CLI = useDist ? DIST_CLI : SRC_CLI;
const TEMPLATE = resolve(PACKAGE_ROOT, "templates", "template1.pptx");
/**
 * Run the CLI and capture output.
 *
 * `spawn` with an argv array rather than a shell string: repository URLs, paths
 * and titles come from a model and must never be interpreted by a shell.
 */
function runCli(args, signal) {
    const { promise, resolve } = Promise.withResolvers();
    const child = spawn(RUNTIME, [CLI, ...args], {
        cwd: PACKAGE_ROOT,
        ...(signal ? { signal } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: err.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    return promise;
}
/** Build the CLI argv from typed parameters. */
function buildArgs(params) {
    const args = ["--repo", params.repo, "--out", params.out ?? "out", "-y"];
    if (params.start !== undefined)
        args.push("--start", params.start);
    if (params.end !== undefined)
        args.push("--end", params.end);
    // With -y and no window the CLI would fall through to its own default; state
    // it here so the behaviour is explicit and the echoed range is predictable.
    args.push("--preset", params.preset ?? "this");
    if (params.title !== undefined)
        args.push("--title", params.title);
    if (params.tz !== undefined)
        args.push("--tz", params.tz);
    if (params.template !== undefined) {
        args.push("--pptx-template", params.template === "served" ? TEMPLATE : params.template);
    }
    if (params.offline === true)
        args.push("--offline");
    if (params.llm !== undefined)
        args.push("--llm", params.llm);
    return args;
}
export default function decktective(pi) {
    pi.setLabel("Decktective");
    pi.registerTool({
        name: "decktective",
        label: "Build weekly deck",
        description: "Build a weekly activity deck (PPTX) from a git repository, filling a .pptx " +
            "template. Provide the repo (URL, owner/repo, or local path) and either a " +
            "--preset like 'this'/'last' or explicit ISO start/end instants WITH an offset. " +
            "Returns the path of the generated deck.",
        // ONLY `repo` is required. Everything else is a legitimate omission: a
        // caller may give a preset OR start+end, and the rest have sane defaults.
        // Declaring them required makes the tool reject every normal call — which
        // is exactly what shipped in 0.1.4/0.1.5, because the schema was never
        // exercised (the test's zod stub did not validate).
        parameters: pi.zod.object({
            repo: pi.zod.string(),
            preset: pi.zod.string().optional(),
            start: pi.zod.string().optional(),
            end: pi.zod.string().optional(),
            out: pi.zod.string().optional(),
            title: pi.zod.string().optional(),
            template: pi.zod.string().optional(),
            tz: pi.zod.string().optional(),
            offline: pi.zod.boolean().optional(),
            llm: pi.zod.string().optional(),
        }),
        async execute(_toolCallId, params, signal) {
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
        handler: async (args, ctx) => {
            const parts = args.trim().split(/\s+/).filter(Boolean);
            if (parts.length === 0) {
                ctx.ui.notify("Usage: /deck <repo> [--preset this|last] [--offline]", "info");
                return;
            }
            const [repo, ...rest] = parts;
            const presetIdx = rest.indexOf("--preset");
            const params = {
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
