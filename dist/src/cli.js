#!/usr/bin/env node
/**
 * decktective CLI.
 *
 *   node src/cli.ts --repo <path> [--preset this|last|4w] [--start ISO --end ISO]
 *                   [--tz Zone] [--out dir] [--title "..."] [--pptx|--pdf]
 *
 * Window selection is interactive when no explicit range is given: probe
 * density, show a histogram, resolve, and echo the absolute range before the
 * expensive churn pass runs.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { GitSource } from "./sources/git.js";
import { resolveRepo } from "./sources/remote.js";
import { TemplateNarrative } from "./narrative/template.js";
import { assertFactLocked } from "./narrative/validate.js";
import { buildDeck } from "./deck/build.js";
import { loadTemplate, DEFAULT_TEMPLATE_PATH } from "./template/load.js";
import { fillWeeklyTemplate, KNOWN_GAPS } from "./pptx/weekly.js";
import { outlineTemplate } from "./pptx/outline.js";
import { executeManifest } from "./pptx/execute.js";
import { isoWeekLabel } from "./deck/build.js";
import { learnManifest, loadManifest, saveManifest, manifestCachePath, } from "./pptx/manifest.js";
import { resolveProvider, isLive, OfflineProvider } from "./llm/provider.js";
import { runPipeline } from "./work/pipeline.js";
import { loadStyleContract, installStyleSkill, STYLE_SKILL_NAME } from "./style/contract.js";
import { outlineToPrompt } from "./pptx/outline.js";
import { resolvePlan } from "./layout/resolve.js";
import { writePptx } from "./render/pptx.js";
import { writePdf } from "./render/pdf.js";
import { describeWindow, densityHistogram, isoWeekWindow, lastNWeeks, previousIsoWeek, dateInZone, } from "./window.js";
function parseArgs(argv) {
    const a = {
        tz: "Asia/Jakarta", out: "out", pptx: true, pdf: true, yes: false, exclude: [],
    };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const v = argv[i + 1];
        switch (k) {
            case "--repo":
                a.repo = v;
                i++;
                break;
            case "--preset":
                a.preset = v;
                i++;
                break;
            case "--start":
                a.start = v;
                i++;
                break;
            case "--end":
                a.end = v;
                i++;
                break;
            case "--tz":
                a.tz = v ?? a.tz;
                i++;
                break;
            case "--out":
                a.out = v ?? a.out;
                i++;
                break;
            case "--title":
                a.title = v;
                i++;
                break;
            case "--exclude":
                a.exclude = (v ?? "").split(",").filter(Boolean);
                i++;
                break;
            case "--narrative":
                a.narrative = v;
                i++;
                break;
            case "--template":
                a.template = v;
                i++;
                break;
            case "--pptx-template":
                a.pptxTemplate = v;
                i++;
                break;
            case "--max-days":
                a.maxDays = Number(v);
                i++;
                break;
            case "--llm":
                a.llm = v;
                i++;
                break;
            case "--offline":
                a.offline = true;
                break;
            case "--attempts":
                a.attempts = Number(v);
                i++;
                break;
            case "--style":
                a.style = v;
                i++;
                break;
            case "--install-style":
                a.installStyle = true;
                break;
            case "--template-outline":
                a.templateOutline = true;
                break;
            case "--learn-template":
                a.learnTemplate = true;
                break;
            case "--manifest":
                a.manifest = v;
                i++;
                break;
            case "--dump-template":
                a.dumpTemplate = true;
                break;
            case "--pptx-only":
                a.pdf = false;
                break;
            case "--pdf-only":
                a.pptx = false;
                break;
            case "--yes":
            case "-y":
                a.yes = true;
                break;
            case "--help":
            case "-h":
                usage();
                process.exit(0);
            default:
                if (k && k.startsWith("--")) {
                    console.error(`unknown flag: ${k}`);
                    usage();
                    process.exit(2);
                }
        }
    }
    return a;
}
function usage() {
    console.log(`decktective — weekly deck from git activity

  --repo <path>      repository to read (default: cwd)
  --preset <name>    this | last | 4w
  --start <iso>      explicit window start (ISO 8601 with offset)
  --end <iso>        explicit window end (exclusive)
  --tz <zone>        IANA timezone (default Asia/Jakarta)
  --out <dir>        output directory (default ./out)
  --title <text>     deck title
  --exclude <paths>  comma-separated path PREFIXES (not globs) to exclude
                     from churn, e.g. package-lock.json,dist/
  --narrative <file> use an agent-written Narrative JSON instead of the
                     deterministic template; fact-locked before rendering
  --template <file>  deck template JSON (theme, layouts, skeleton).
                     Default: templates/weekly.template.json
  --pptx-template <file>
                     fill a real .pptx template instead of generating slides.
                     The day section resizes to the actual number of active
                     days (max 7). PPTX only: producing PDF from a .pptx would
                     need LibreOffice, which is unavailable.
  --max-days <n>     cap on day slides in --pptx-template mode (default 7)
  --llm <spec>       model for the pipeline stages, as "provider/model",
                     e.g. commandcode/deepseek/deepseek-v4-flash,
                     openai/gpt-5, anthropic/claude-sonnet-5. Providers:
                     commandcode | openai | anthropic (keys via
                     COMMANDCODE_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY).
                     Default: first provider with a key set.
  --offline          no model at all; every stage uses its deterministic
                     fallback. Reproducible and nothing leaves the machine.
  --attempts <n>     review-loop attempts before giving up (default 3). The
                     loop re-runs grouping and articulation when the draft
                     violates the output contract.
  --style <path|url> output-style contract to enforce (a SKILL.md). Defaults
                     to the installed skill, else the upstream package
                     (ayghri/i-have-adhd), cached on first use.
  --install-style    fetch that package's skill into .omp/skills/ so the
                     harness also discovers it, then exit.
  --template-outline print a text outline of the --pptx-template (shape ids,
                     positions, placeholder text) and exit. This is what a
                     model reads instead of the .pptx, which it cannot parse.
  --learn-template   derive a fill plan for --pptx-template with the model,
                     cache it, and exit. Needed once for a template this repo
                     does not ship.
  --manifest <file>  render using a learned (or hand-written) template
                     manifest instead of the served fill plan. Pair with
                     --pptx-template so the shape ids match.
  --dump-template    print the resolved template as JSON and exit.
                     Use it as a starting point for a generated template
  --pptx-only        skip PDF
  --pdf-only         skip PPTX
  -y, --yes          never prompt; use the default window (this week)
  -h, --help         show this message`);
}
/** Probe commit density cheaply so the user picks a window against real data. */
async function probeDensity(src, tz, weeksBack = 12) {
    const now = new Date();
    const from = lastNWeeks(tz, now, weeksBack);
    const days = await src.collect({ start: from.start, end: from.end, tz }, { commitsOnly: true });
    const counts = new Map();
    for (const d of days)
        counts.set(d.date, d.metrics.commits);
    return counts;
}
function resolveFromPreset(preset, tz) {
    const now = new Date();
    switch (preset) {
        case "this": return isoWeekWindow(tz, now);
        case "last": return previousIsoWeek(tz, now);
        case "4w": return lastNWeeks(tz, now, 4);
        default:
            throw new Error(`unknown preset "${preset}" (expected: this | last | 4w)`);
    }
}
function openPrompts() {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const prompts = { rl, ended: false };
    rl.on("close", () => {
        prompts.ended = true;
    });
    return prompts;
}
async function ask(prompts, prompt) {
    if (prompts.ended)
        return "";
    try {
        return (await prompts.rl.question(prompt)).trim();
    }
    catch {
        return ""; // stdin ended (piped input, Ctrl-D)
    }
}
async function chooseWindow(args, src, prompts) {
    if (args.start && args.end) {
        return { start: args.start, end: args.end, tz: args.tz };
    }
    if (args.preset)
        return resolveFromPreset(args.preset, args.tz);
    // Non-interactive: cannot ask, so take the default rather than hang or no-op.
    if (args.yes)
        return isoWeekWindow(args.tz, new Date());
    const counts = await probeDensity(src, args.tz);
    const now = new Date();
    const weeks = [];
    for (let i = 11; i >= 0; i--) {
        weeks.push(lastNWeeks(args.tz, new Date(now.getTime() - i * 7 * 86400000), 1));
    }
    console.log(`\nCommit density, last 12 weeks (${args.tz}):\n`);
    console.log(densityHistogram(counts, weeks));
    console.log("");
    const answer = (await ask(prompts, "Window? [this] week / [last] week / last [4] weeks / or an ISO date like 2026-09-01: ")).toLowerCase();
    if (answer === "" || answer === "this")
        return isoWeekWindow(args.tz, now);
    if (answer === "last")
        return previousIsoWeek(args.tz, now);
    if (answer === "4" || answer === "4w")
        return lastNWeeks(args.tz, now, 4);
    if (/^\d{4}-\d{2}-\d{2}$/.test(answer)) {
        return isoWeekWindow(args.tz, new Date(`${answer}T00:00:00Z`));
    }
    throw new Error(`unrecognised window selection: ${answer}`);
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    // Describe a template for a model: shape ids, positions, placeholder text.
    if (args.templateOutline) {
        const target = args.pptxTemplate;
        if (target === undefined)
            throw new Error("--template-outline needs --pptx-template <file>");
        const outline = await outlineTemplate(resolve(target), { withFontSizes: true });
        console.log(outlineToPrompt(outline));
        return;
    }
    // Learn a fill plan for a template this repo does not ship, then cache it.
    if (args.learnTemplate) {
        const target = args.pptxTemplate;
        if (target === undefined)
            throw new Error("--learn-template needs --pptx-template <file>");
        const provider = resolveProvider(args.llm === undefined ? {} : { spec: args.llm });
        if (!isLive(provider)) {
            throw new Error("--learn-template needs a model: pass --llm or set a provider key");
        }
        const templatePath = resolve(target);
        const outline = await outlineTemplate(templatePath, { withFontSizes: true });
        const { manifest, issues } = await learnManifest(provider, outline, templatePath);
        const cache = manifestCachePath(templatePath, join(homedir(), ".cache", "decktective"));
        await saveManifest(cache, manifest);
        console.log(`learned ${manifest.steps.length} step(s) from ${target}`);
        console.log(`wrote ${cache}`);
        if (manifest.notes.length > 0) {
            console.log("  model notes:");
            for (const n of manifest.notes)
                console.log(`    ${n}`);
        }
        if (issues.length > 0) {
            console.log(`  warn: ${issues.length} issue(s) in the learned plan:`);
            for (const i of issues)
                console.log(`    ${i.path}: ${i.message}`);
        }
        return;
    }
    // Install the upstream style package as a harness skill, then exit.
    if (args.installStyle) {
        const installed = await installStyleSkill();
        console.log(`installed ${STYLE_SKILL_NAME} skill at ${installed}`);
        return;
    }
    // No repo needed: emit the resolved template as a starting point for edits
    // or for a model to adapt into a custom one.
    if (args.dumpTemplate) {
        const template = await loadTemplate(args.template);
        console.log(JSON.stringify(template, null, 2));
        const source = args.template ?? DEFAULT_TEMPLATE_PATH;
        console.error(`\n(template "${template.id}" v${template.version} from ${source})`);
        return;
    }
    // `--repo` takes a URL, an owner/repo shorthand, or a local path, so a caller
    // can pass whatever the user pointed at without a separate clone step.
    const repo = await resolveRepo(args.repo ?? process.cwd(), {
        ...(args.offline ? { offline: true } : {}),
    });
    if (repo.cloned)
        console.log(`Cloned ${repo.source} -> ${repo.path}`);
    else if (repo.fetched)
        console.log(`Refreshed ${repo.path}`);
    const repoPath = repo.path;
    const source = new GitSource({ id: repo.id, path: repoPath });
    const prompts = openPrompts();
    let window;
    try {
        window = await chooseWindow(args, source, prompts);
        // Always echo the resolved absolute range before the expensive pass.
        console.log(`\nWindow: ${describeWindow(window)}`);
        if (!args.yes) {
            const ok = (await ask(prompts, "Generate deck for this window? [Y/n] ")).toLowerCase();
            if (ok === "n" || ok === "no") {
                console.log("aborted");
                return;
            }
        }
    }
    finally {
        prompts.rl.close();
    }
    const collectOpts = { exclude: args.exclude, detectRenames: true };
    const days = await source.collect(window, collectOpts);
    const totalCommits = days.reduce((a, d) => a + d.metrics.commits, 0);
    console.log(`Collected ${totalCommits} commits across ${days.length} day(s).`);
    // Repo-level warnings first: an empty window would otherwise hide a truncated clone.
    for (const w of (await source.diagnostics?.(collectOpts)) ?? []) {
        console.log(`  warn: ${w}`);
    }
    const warnings = days.flatMap((d) => (d.warnings ?? []).map((w) => `${d.date}: ${w}`));
    for (const w of [...new Set(warnings)])
        console.log(`  warn: ${w}`);
    let narrative;
    if (args.narrative) {
        // Agent/model-written narrative: load then fact-lock before it can reach a slide.
        narrative = JSON.parse(await readFile(args.narrative, "utf8"));
        assertFactLocked(narrative, days);
        console.log("narrative loaded and fact-locked");
    }
    else {
        narrative = await new TemplateNarrative().narrate(days, window);
    }
    // Group commits into work items. With a model this is semantic ("the sidebar
    // redesign"); offline it falls back to grouping by kind. Either way every
    // number is computed from the commits, never from the model.
    const provider = args.offline ? new OfflineProvider() : resolveProvider(args.llm === undefined ? {} : { spec: args.llm });
    // Style contract is only needed when a model will actually judge against it.
    let contract;
    if (isLive(provider)) {
        contract = await loadStyleContract({
            ...(args.style === undefined ? {} : { path: args.style }),
            ...(args.offline ? { offline: true } : {}),
        });
    }
    const pipeline = await runPipeline(days, {
        provider,
        window,
        ...(contract === undefined ? {} : { contract }),
        ...(args.attempts === undefined ? {} : { maxAttempts: args.attempts }),
    });
    console.log(`Grouped ${days.reduce((a, d) => a + d.items.length, 0)} item(s) into ` +
        `${pipeline.workItems.length} work item(s)` +
        `${isLive(provider) ? ` via ${provider.id}/${provider.model}` : " (offline)"}` +
        `${pipeline.fabricatedRefs.length > 0 ? `; ignored ${pipeline.fabricatedRefs.length} unknown ref(s)` : ""}.`);
    if (pipeline.degraded !== undefined) {
        console.log(`  warn: ${pipeline.degraded}; used the deterministic path`);
    }
    if (pipeline.styleSource !== undefined) {
        console.log(`  style gate: ${STYLE_SKILL_NAME} (${pipeline.styleSource})`);
    }
    if (pipeline.reviewSkipped !== undefined) {
        console.log(`  note: ${pipeline.reviewSkipped}`);
    }
    if (pipeline.attempts > 1)
        console.log(`  review loop: ${pipeline.attempts} attempt(s)`);
    if (pipeline.violations.length > 0) {
        console.log(`  warn: ${pipeline.violations.length} contract violation(s) remain:`);
        for (const v of pipeline.violations)
            console.log(`    [${v.rule}] ${v.where}: ${v.detail}`);
    }
    // The reviewed articulation replaces the template narrative's prose.
    narrative = {
        ...narrative,
        summary: pipeline.articulation.summary || narrative.summary,
        risks: pipeline.articulation.blockers.length > 0
            ? pipeline.articulation.blockers
            : narrative.risks,
        nextWeek: pipeline.articulation.nextSteps.length > 0
            ? pipeline.articulation.nextSteps
            : narrative.nextWeek,
    };
    const grouping = { items: pipeline.workItems };
    await mkdir(args.out, { recursive: true });
    // Template mode fills a real .pptx rather than generating slides, so it
    // bypasses the IR entirely and emits PPTX only.
    if (args.pptxTemplate) {
        const stem = `${dateInZone(window.tz, new Date(window.start))}_filled`;
        const outPath = resolve(args.out, `${stem}.pptx`);
        // A manifest drives an arbitrary template: the plan says which shape on
        // which slide receives which data, and the executor applies it.
        if (args.manifest) {
            const manifest = await loadManifest(resolve(args.manifest));
            const data = {
                days,
                narrative,
                workItems: grouping.items,
                window,
                title: args.title ?? manifest.name,
                week: isoWeekLabel(window.start, window.tz),
            };
            const result = await executeManifest({
                templatePath: resolve(args.pptxTemplate),
                manifest,
                data,
                outPath,
                ...(args.maxDays === undefined ? {} : { maxDays: args.maxDays }),
            });
            console.log(`wrote ${outPath} (${result.slides} slide(s), ${result.filled.length} shape(s) filled from manifest)`);
            if (result.unsupported.length > 0) {
                console.log("  not rendered by the manifest:");
                for (const u of [...new Set(result.unsupported)])
                    console.log(`    ${u}`);
            }
            return;
        }
        const result = await fillWeeklyTemplate({
            templatePath: resolve(args.pptxTemplate),
            outPath,
            days,
            narrative,
            workItems: grouping.items,
            window,
            ...(args.maxDays === undefined ? {} : { maxDays: args.maxDays }),
        });
        console.log(`wrote ${outPath} (${result.dayCount} day slide(s), ${result.filledCount} fields filled)`);
        if (result.droppedDays.length > 0) {
            console.log(`  warn: window has more days than the cap; dropped ${result.droppedDays.join(", ")}`);
        }
        if (result.unfilled.length > 0) {
            console.log("  not fillable from git (left as placeholders):");
            for (const u of result.unfilled)
                console.log(`    ${u}`);
        }
        console.log("  known gaps in this template:");
        for (const gap of KNOWN_GAPS)
            console.log(`    ${gap}`);
        return;
    }
    const template = await loadTemplate(args.template);
    const ir = buildDeck(days, narrative, window, template, { title: args.title });
    // Resolve layout once; emitters are dumb translators of the plan.
    const plan = resolvePlan(ir);
    const stem = `${dateInZone(window.tz, new Date(window.start))}_${ir.meta.week}`;
    await writeFile(resolve(args.out, `${stem}.json`), `${JSON.stringify(ir, null, 2)}\n`);
    if (args.pptx) {
        const p = resolve(args.out, `${stem}.pptx`);
        await writePptx(plan, p);
        console.log(`wrote ${p}`);
    }
    if (args.pdf) {
        const p = resolve(args.out, `${stem}.pdf`);
        await writePdf(plan, p);
        console.log(`wrote ${p}`);
    }
    console.log(`wrote ${resolve(args.out, `${stem}.json`)} (IR)`);
}
main().catch((err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
