/**
 * Execute a learned template manifest.
 *
 * A manifest says "put `fillKind` into shape id X on slide N". This turns that
 * into a filled deck using the same primitives as the served template, so a
 * generated plan and the hand-written one behave identically — and every write
 * goes through the fit gate, so a plan that maps a long payload into a small box
 * gets clamped rather than overflowing.
 *
 * Content is JOINTED into a single line per shape. Multi-paragraph insertion
 * would need per-run XML surgery per shape style, and a one-line payload that is
 * clamped reads correctly; the alternative is silently truncating mid-list.
 */
import { PptxPackage } from "./package.ts";
import { readShapes, setShapeTextFitted, type Bindings } from "./fill.ts";
import type { TemplateManifest, FillKind } from "./manifest.ts";
import { plural } from "../narrative/template.ts";
import type { DayEntry, Narrative, Window, WorkItem } from "../ir/types.ts";

const JOIN = "  \u00b7  ";

export type DeckData = {
  days: DayEntry[];
  narrative: Narrative;
  workItems: WorkItem[];
  window: Window;
  title: string;
  week: string;
};

export type ExecuteResult = {
  slides: number;
  filled: Array<{ slide: number; shape: string; kind: FillKind }>;
  /** Kinds the manifest asked for that we could not render. */
  unsupported: FillKind[];
};

const shortDate = (iso: string, tz: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short", year: "numeric" })
    .format(new Date(iso));

function windowLabel(w: Window, week: string): string {
  const last = new Date(new Date(w.end).getTime() - 1000);
  return `${shortDate(w.start, w.tz)} \u2013 ${shortDate(last.toISOString(), w.tz)}  \u00b7  ${w.tz}  \u00b7  ${week}`;
}

/** Day heading, e.g. "Wednesday 29th Jan 2026". */
function dayHeading(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", weekday: "long", month: "short", year: "numeric",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = d.getUTCDate();
  const v = day % 100;
  const suffix = ["th", "st", "nd", "rd"][(v - 20) % 10] ?? ["th", "st", "nd", "rd"][v] ?? "th";
  return `${get("weekday")} ${day}${suffix} ${get("month")} ${get("year")}`;
}

const totals = (days: DayEntry[]) =>
  days.reduce(
    (a, d) => ({
      commits: a.commits + d.metrics.commits,
      additions: a.additions + d.metrics.additions,
      deletions: a.deletions + d.metrics.deletions,
      active: a.active + (d.metrics.commits > 0 ? 1 : 0),
    }),
    { commits: 0, additions: 0, deletions: 0, active: 0 },
  );

/** The day's work items, heaviest first. */
const itemsForDay = (items: WorkItem[], date: string): WorkItem[] =>
  items
    .filter((w) => w.days.includes(date))
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));

/**
 * Render one fill kind to a single line.
 *
 * `day` is present only for per-day steps, and a kind that needs a day without
 * one yields an empty string rather than a wrong answer.
 */
export function renderFill(kind: FillKind, data: DeckData, day?: DayEntry): string {
  const t = totals(data.days);
  switch (kind) {
    case "deck-title":
      return data.title;
    case "window-label":
      return windowLabel(data.window, data.week);
    case "summary":
      return data.narrative.summary;
    case "metrics":
      return [
        plural(t.commits, "commit"),
        `+${t.additions.toLocaleString("en-US")} / -${t.deletions.toLocaleString("en-US")}`,
        `${t.active} active ${t.active === 1 ? "day" : "days"}`,
      ].join(JOIN);
    case "per-day-breakdown":
      return data.days
        .filter((d) => d.metrics.commits > 0)
        .map((d) => `${d.date} ${plural(d.metrics.commits, "commit")}`)
        .join(JOIN);
    case "agenda":
      return data.narrative.days.map((d) => `${d.date} ${d.headline}`).join(JOIN);
    case "themes":
      return data.narrative.themes.map((th) => `${th.title} (${th.refs.length})`).join(JOIN);
    case "risks":
      return data.narrative.risks.join(JOIN);
    case "next-week":
      return data.narrative.nextWeek.join(JOIN);
    case "evidence": {
      const repos = [...new Set(data.days.map((d) => d.sourceId))];
      const refs = data.days.flatMap((d) => d.items.flatMap((i) => i.refs ?? [])).slice(0, 8);
      return [
        repos.join(" + "),
        plural(t.commits, "commit"),
        refs.map((r) => r.slice(0, 7)).join(" "),
      ].filter((s) => s !== "").join(JOIN);
    }
    case "day-heading":
      return day ? dayHeading(day.date) : "";
    case "day-summary": {
      if (!day) return "";
      const items = itemsForDay(data.workItems, day.date);
      const body = (items.length > 0 ? items : []).map((w) => w.title).join("  |  ");
      const meta = `+${day.metrics.additions.toLocaleString("en-US")} / -${day.metrics.deletions.toLocaleString("en-US")}`;
      return body === "" ? meta : `${body}  \u00b7  ${meta}`;
    }
  }
}

export type ExecuteOptions = {
  templatePath: string;
  manifest: TemplateManifest;
  data: DeckData;
  /** Slide number to clone once per active day. */
  outPath: string;
  maxDays?: number;
};

const MAX_DAYS = 7;

/**
 * Fill a template according to a manifest.
 *
 * Steps run in the manifest's order. A `repeat: "per-day"` step clones its slide
 * once per active day (capped), then each copy is filled with that day's content,
 * so day slides are produced from a single authored layout.
 */
export async function executeManifest(opts: ExecuteOptions): Promise<ExecuteResult> {
  const { manifest, data } = opts;
  const pkg = await PptxPackage.load(opts.templatePath);
  // Manifest slide numbers refer to the TEMPLATE. Snapshot the order now,
  // because cloning the per-day slide shifts every later index.
  const originalAll = pkg.slides();
  const filled: ExecuteResult["filled"] = [];
  const unsupported = new Set<FillKind>();

  // Drop slides the plan declares as duplicates of the per-day layout BEFORE
  // cloning, so the day run is not multiplied by the leftovers. Removed from the
  // tail first so earlier template slide numbers stay addressable.
  const omitted = new Set(manifest.omit ?? []);
  for (const slideNo of [...omitted].sort((a, b) => b - a)) {
    const ref = originalAll[slideNo - 1];
    if (ref !== undefined) await pkg.remove(ref.part);
  }
  // Template slide number -> surviving part. Manifest numbers refer to the
  // TEMPLATE, so this is the mapping every non-per-day step resolves through.
  const original = originalAll.filter((_r, i) => !omitted.has(i + 1));

  const activeDays = data.days.filter((d) => d.metrics.commits > 0).slice(0, opts.maxDays ?? MAX_DAYS);
  const perDayStep = manifest.steps.find((s) => s.repeat === "per-day");

  // Clone the per-day slide up front: cloning shifts later slide numbers, so the
  // day run must exist before any other step resolves its own slide.
  const clonesByDay = new Map<number, string>();
  if (perDayStep !== undefined) {
    const refs = pkg.slides();
    const proto = refs[perDayStep.slide - 1];
    if (proto === undefined) throw new Error(`manifest names slide ${perDayStep.slide}, which does not exist`);
    let last = proto.part;
    for (let i = 0; i < activeDays.length; i++) {
      const part = i === 0 ? last : await pkg.duplicate(last);
      clonesByDay.set(i, part);
      last = part;
    }
  }

  /** Resolve a manifest slide number to the part holding it, per day index. */
  const partForStep = (slide: number, dayIndex: number): string | undefined => {
    const perDayAt = perDayStep === undefined ? -1 : perDayStep.slide - 1;
    if (perDayAt >= 0 && slide - 1 === perDayAt) return clonesByDay.get(dayIndex);
    return original[slide - 1]?.part;
  };

  for (const step of manifest.steps) {
    const dayCount = step.repeat === "per-day" ? activeDays.length : 1;

    for (let dayIndex = 0; dayIndex < dayCount; dayIndex++) {
      const part = partForStep(step.slide, dayIndex);
      if (part === undefined) continue;
      const day = step.repeat === "per-day" ? activeDays[dayIndex] : undefined;

      // Title text on the step, with {week} / {date} substitution.
      const bindings: Bindings = {};
      if (step.title !== undefined && day !== undefined) {
        bindings[step.title] = "";
      }

      let xml = await pkg.xml(part);
      const present = new Set(readShapes(xml).map((s) => s.id));
      for (const [shapeId, kind] of Object.entries(step.slots)) {
        const value = renderFill(kind, data, day);
        // A kind that needs a day (or that this week has no data for) yields
        // nothing; report it rather than writing an empty box.
        if (value === "") {
          unsupported.add(kind);
          continue;
        }
        if (!present.has(shapeId)) {
          unsupported.add(kind);
          continue;
        }
        xml = setShapeTextFitted(xml, shapeId, value);
        filled.push({ slide: step.slide, shape: shapeId, kind });
      }
      pkg.setXml(part, xml);
    }
  }

  await pkg.save(opts.outPath);
  return { slides: pkg.slides().length, filled, unsupported: [...unsupported] };
}
