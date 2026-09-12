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
import { basename, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";

import { GitSource } from "./sources/git.ts";
import { TemplateNarrative } from "./narrative/template.ts";
import { assertFactLocked } from "./narrative/validate.ts";
import { buildDeck } from "./deck/build.ts";
import { resolvePlan } from "./layout/resolve.ts";
import { writePptx } from "./render/pptx.ts";
import { writePdf } from "./render/pdf.ts";
import {
  describeWindow, densityHistogram, isoWeekWindow, lastNWeeks,
  previousIsoWeek, dateInZone,
} from "./window.ts";
import type { IsoDate, Narrative, Window } from "./ir/types.ts";

type Args = {
  repo?: string;
  preset?: string;
  start?: string;
  end?: string;
  tz: string;
  out: string;
  title?: string;
  pptx: boolean;
  pdf: boolean;
  yes: boolean;
  exclude: string[];
  narrative?: string;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    tz: "Asia/Jakarta", out: "out", pptx: true, pdf: true, yes: false, exclude: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--repo": a.repo = v; i++; break;
      case "--preset": a.preset = v; i++; break;
      case "--start": a.start = v; i++; break;
      case "--end": a.end = v; i++; break;
      case "--tz": a.tz = v ?? a.tz; i++; break;
      case "--out": a.out = v ?? a.out; i++; break;
      case "--title": a.title = v; i++; break;
      case "--exclude": a.exclude = (v ?? "").split(",").filter(Boolean); i++; break;
      case "--narrative": a.narrative = v; i++; break;
      case "--pptx-only": a.pdf = false; break;
      case "--pdf-only": a.pptx = false; break;
      case "--yes": case "-y": a.yes = true; break;
      case "--help": case "-h": usage(); process.exit(0);
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

function usage(): void {
  console.log(`decktective — weekly deck from git activity

  --repo <path>      repository to read (default: cwd)
  --preset <name>    this | last | 4w
  --start <iso>      explicit window start (ISO 8601 with offset)
  --end <iso>        explicit window end (exclusive)
  --tz <zone>        IANA timezone (default Asia/Jakarta)
  --out <dir>        output directory (default ./out)
  --title <text>     deck title
  --exclude <globs>  comma-separated path prefixes to exclude from churn
  --narrative <file> use an agent-written Narrative JSON instead of the
                     deterministic template; fact-locked before rendering
  --pptx-only        skip PDF
  --pdf-only         skip PPTX
  -y, --yes          never prompt; use the default window (this week)`);
}

/** Probe commit density cheaply so the user picks a window against real data. */
async function probeDensity(
  src: GitSource, tz: string, weeksBack = 12,
): Promise<Map<IsoDate, number>> {
  const now = new Date();
  const from = lastNWeeks(tz, now, weeksBack);
  const days = await src.collect({ start: from.start, end: from.end, tz }, { commitsOnly: true });
  const counts = new Map<IsoDate, number>();
  for (const d of days) counts.set(d.date, d.metrics.commits);
  return counts;
}

function resolveFromPreset(preset: string, tz: string): Window {
  const now = new Date();
  switch (preset) {
    case "this": return isoWeekWindow(tz, now);
    case "last": return previousIsoWeek(tz, now);
    case "4w": return lastNWeeks(tz, now, 4);
    default:
      throw new Error(`unknown preset "${preset}" (expected: this | last | 4w)`);
  }
}

/**
 * Ask one question on a shared interface.
 *
 * A second `createInterface` over the same stdin is the trap: when the first is
 * closed, stdin ends, so the next `question()` never resolves, the event loop
 * drains, and node exits 0 having done nothing. One interface for the whole
 * session, and an EOF answer resets to the default instead of hanging.
 */
type Prompts = { rl: Interface; ended: boolean };

function openPrompts(): Prompts {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompts: Prompts = { rl, ended: false };
  rl.on("close", () => {
    prompts.ended = true;
  });
  return prompts;
}

async function ask(prompts: Prompts, prompt: string): Promise<string> {
  if (prompts.ended) return "";
  try {
    return (await prompts.rl.question(prompt)).trim();
  } catch {
    return ""; // stdin ended (piped input, Ctrl-D)
  }
}

async function chooseWindow(args: Args, src: GitSource, prompts: Prompts): Promise<Window> {
  if (args.start && args.end) {
    return { start: args.start, end: args.end, tz: args.tz };
  }
  if (args.preset) return resolveFromPreset(args.preset, args.tz);
  // Non-interactive: cannot ask, so take the default rather than hang or no-op.
  if (args.yes) return isoWeekWindow(args.tz, new Date());

  const counts = await probeDensity(src, args.tz);
  const now = new Date();
  const weeks: Window[] = [];
  for (let i = 11; i >= 0; i--) {
    weeks.push(lastNWeeks(args.tz, new Date(now.getTime() - i * 7 * 86400000), 1));
  }

  console.log(`\nCommit density, last 12 weeks (${args.tz}):\n`);
  console.log(densityHistogram(counts, weeks));
  console.log("");

  const answer = (await ask(
    prompts,
    "Window? [this] week / [last] week / last [4] weeks / or an ISO date like 2026-09-01: ",
  )).toLowerCase();

  if (answer === "" || answer === "this") return isoWeekWindow(args.tz, now);
  if (answer === "last") return previousIsoWeek(args.tz, now);
  if (answer === "4" || answer === "4w") return lastNWeeks(args.tz, now, 4);

  if (/^\d{4}-\d{2}-\d{2}$/.test(answer)) {
    return isoWeekWindow(args.tz, new Date(`${answer}T00:00:00Z`));
  }
  throw new Error(`unrecognised window selection: ${answer}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoPath = resolve(args.repo ?? process.cwd());
  const source = new GitSource({ id: basename(repoPath), path: repoPath });

  const prompts = openPrompts();
  let window: Window;
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
  } finally {
    prompts.rl.close();
  }

  const days = await source.collect(window, { exclude: args.exclude, detectRenames: true });
  const totalCommits = days.reduce((a, d) => a + d.metrics.commits, 0);
  console.log(`Collected ${totalCommits} commits across ${days.length} day(s).`);

  const warnings = days.flatMap((d) => (d.warnings ?? []).map((w) => `${d.date}: ${w}`));
  for (const w of [...new Set(warnings)]) console.log(`  warn: ${w}`);

  let narrative: Narrative;
  if (args.narrative) {
    // Agent/model-written narrative: load then fact-lock before it can reach a slide.
    narrative = JSON.parse(await readFile(args.narrative, "utf8")) as Narrative;
    assertFactLocked(narrative, days);
    console.log("narrative loaded and fact-locked");
  } else {
    narrative = await new TemplateNarrative().narrate(days, window);
  }
  const ir = buildDeck(days, narrative, window, { title: args.title ?? "Weekly Deck" });

  // Resolve layout once; emitters are dumb translators of the plan.
  const plan = resolvePlan(ir);

  await mkdir(args.out, { recursive: true });
  const stem = `${dateInZone(window.tz, new Date(window.start))}_${ir.meta.week}`;
  await writeFile(
    resolve(args.out, `${stem}.json`),
    `${JSON.stringify(ir, null, 2)}\n`,
  );

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

main().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
