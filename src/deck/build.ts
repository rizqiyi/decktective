/**
 * Deck construction: facts + narrative + template -> DeckIR.
 *
 * This is an interpreter, not a layout. It walks the template's skeleton and
 * resolves each slot's fill against the available data — which means a
 * different template produces a different deck with no change here. Content
 * rules that are NOT free to vary (bullet budgets, pluralisation, pagination)
 * stay in code, because they are editorial policy rather than layout.
 */
import type {
  Block, DayEntry, DayNarrative, DeckIR, DeckTemplate, FillSpec, Narrative,
  Slide, TemplateStep, Theme, Window,
} from "../ir/types.ts";
import { plural } from "../narrative/template.ts";

/** A slide the reader can absorb: one line per bullet, few words each. */
const MAX_BULLETS = 6;
const MAX_BULLET_WORDS = 7;
const EVIDENCE_PER_PAGE = 22;

const textBlock = (t: string, emphasis?: "normal" | "muted" | "accent"): Block =>
  ({ kind: "text", text: t, emphasis });

const bulletBlock = (items: string[], refs?: string[][]): Block => ({
  kind: "bullets",
  items: items.map((t, i) => ({ text: t, refs: refs?.[i] })),
});

/** A bullet is one line the reader can absorb. */
function clampBullet(text: string, maxWords = MAX_BULLET_WORDS): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords).join(" ")}\u2026`;
}

/** ISO-8601 week label for the window start, computed in the window's timezone. */
export function isoWeekLabel(startIso: string, tz: string): string {
  const d = new Date(startIso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const y = Number(get("year"));
  const m = Number(get("month"));
  const day = Number(get("day"));
  // ISO week: Thursday of the current week determines the week-year.
  const date = new Date(Date.UTC(y, m - 1, day));
  const dow = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function formatDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, day: "2-digit", month: "short", year: "numeric",
  }).format(new Date(iso));
}

type StepContext = {
  days: DayEntry[];
  narrative: Narrative;
  window: Window;
  theme: Theme;
  title: string;
  week: string;
  /** Present only on `repeat: "per-day"` steps. */
  day?: DayNarrative;
  /** 1-based page index within the step, for `{page}`. */
  page: number;
};

/** Substitute `{date}`, `{profile}`, `{week}`, `{page}`, `{title}` in template text. */
function interpolate(template: string, ctx: StepContext): string {
  return template
    .replaceAll("{date}", ctx.day?.date ?? "")
    .replaceAll("{profile}", ctx.day?.profile ?? "")
    .replaceAll("{week}", ctx.week)
    .replaceAll("{page}", String(ctx.page))
    .replaceAll("{title}", ctx.title);
}

function totals(days: DayEntry[]) {
  return days.reduce(
    (acc, d) => ({
      commits: acc.commits + d.metrics.commits,
      additions: acc.additions + d.metrics.additions,
      deletions: acc.deletions + d.metrics.deletions,
      gross: acc.gross + d.metrics.grossChurn,
      active: acc.active + (d.metrics.commits > 0 ? 1 : 0),
    }),
    { commits: 0, additions: 0, deletions: 0, gross: 0, active: 0 },
  );
}

/**
 * Resolve one fill to zero or more blocks. Most fills yield exactly one; the
 * `evidence` fill paginates, handled by the caller via `page`.
 */
function resolveFill(fill: FillSpec, ctx: StepContext): Block | null {
  const { days, narrative: n } = ctx;
  const t0 = totals(days);

  switch (fill.kind) {
    case "text":
      return textBlock(interpolate(fill.text, ctx), fill.emphasis);

    case "deck-title":
      return textBlock(ctx.title);

    case "window-label":
      return textBlock(
        `${formatDate(ctx.window.start, ctx.window.tz)} \u2013 ` +
        `${formatDate(ctx.window.end, ctx.window.tz)}  \u00b7  ` +
        `${ctx.window.tz}  \u00b7  ${ctx.week}`,
        "muted",
      );

    case "summary":
      return textBlock(clampBullet(n.summary, 20), "muted");

    case "agenda": {
      const items = n.days
        .map((d) => `${d.date} \u2014 ${clampBullet(d.headline)}`)
        .slice(0, MAX_BULLETS);
      return bulletBlock(items);
    }

    case "metrics":
      return {
        kind: "metrics",
        items: [
          { label: "Commits", value: t0.commits.toLocaleString("en-US") },
          { label: "Added", value: `+${t0.additions.toLocaleString("en-US")}` },
          { label: "Removed", value: t0.deletions === 0 ? "0" : `-${t0.deletions.toLocaleString("en-US")}` },
          { label: "Active days", value: `${t0.active}/${days.length || 0}` },
        ],
      };

    case "per-day-breakdown": {
      const items = days
        .filter((d) => d.metrics.commits > 0)
        .map((d) => `${d.date}  ${plural(d.metrics.commits, "commit")}  ` +
          `+${d.metrics.additions.toLocaleString("en-US")}/-${d.metrics.deletions.toLocaleString("en-US")}`);
      return bulletBlock(items.map((l) => clampBullet(l, 10)));
    }

    case "day-heading":
      if (!ctx.day) return null;
      return textBlock(`${ctx.day.date}  \u00b7  ${ctx.day.profile}`);

    case "day-items": {
      if (!ctx.day) return null;
      const d = ctx.day;
      const shown = d.items.slice(0, MAX_BULLETS);
      const extra = d.items.length - shown.length;
      const meta = `${plural(d.metrics.commits, "commit")}  \u00b7  ` +
        `+${d.metrics.additions.toLocaleString("en-US")}/-${d.metrics.deletions.toLocaleString("en-US")}`;
      const lines = [
        ...shown.map((i) => clampBullet(i.text)),
        ...(extra > 0 ? [`\u2026and ${extra} more (see appendix)`] : []),
        meta,
      ];
      const refs = shown.flatMap((i) => (i.refs ? [i.refs] : []));
      return bulletBlock(lines, refs);
    }

    case "themes":
      return bulletBlock(
        n.themes.slice(0, MAX_BULLETS).map((th) => `${th.title} (${th.refs.length})`),
      );

    case "risks":
      return bulletBlock(n.risks.slice(0, MAX_BULLETS).map((r) => clampBullet(r, 12)));

    case "next-week":
      return bulletBlock(n.nextWeek.slice(0, MAX_BULLETS).map((r) => clampBullet(r, 12)));

    case "evidence": {
      const rows = days.flatMap((d) =>
        d.items.flatMap((i) =>
          (i.refs ?? []).map((r) => ({
            label: `${d.date}  ${clampBullet(i.text, 9)}`,
            ref: r.slice(0, 10),
          })),
        ),
      );
      const page = rows.slice((ctx.page - 1) * EVIDENCE_PER_PAGE, ctx.page * EVIDENCE_PER_PAGE);
      if (page.length === 0) return null;
      return { kind: "evidence", rows: page };
    }
  }
  return null;
}

/** True when the step has data to show, so optional steps drop out cleanly. */
function stepApplies(step: TemplateStep, ctx: StepContext): boolean {
  switch (step.when ?? "always") {
    case "has-themes": return ctx.narrative.themes.length > 0;
    case "has-risks": return ctx.narrative.risks.length > 0;
    case "has-next-week": return ctx.narrative.nextWeek.length > 0;
    case "has-evidence": return ctx.days.some((d) => d.items.some((i) => (i.refs?.length ?? 0) > 0));
    case "always": return true;
  }
}

/** How many slides this step emits: one per repetition (day or evidence page). */
function stepRepetitions(step: TemplateStep, ctx: StepContext): number {
  if (step.repeat === "per-day") return ctx.narrative.days.length;
  const evidence = Object.values(step.fill).find((f) => f.kind === "evidence");
  if (!evidence) return 1;
  const rows = ctx.days.reduce(
    (n, d) => n + d.items.reduce((m, i) => m + (i.refs?.length ?? 0), 0),
    0,
  );
  return Math.max(1, Math.ceil(rows / EVIDENCE_PER_PAGE));
}

function stepSlides(step: TemplateStep, base: StepContext): Slide[] {
  const slides: Slide[] = [];
  const reps = stepRepetitions(step, base);

  for (let rep = 0; rep < reps; rep++) {
    const ctx: StepContext = {
      ...base,
      page: rep + 1,
      ...(step.repeat === "per-day" ? { day: base.narrative.days[rep] } : {}),
    };

    const slots: Record<string, Block> = {};
    for (const [key, fill] of Object.entries(step.fill)) {
      const block = resolveFill(fill, ctx);
      if (block) slots[key] = block;
    }
    // A repetition with no content at all would be a blank slide.
    if (Object.keys(slots).length === 0) continue;

    const slide: Slide = { layout: step.layout, slots };
    if (step.title !== undefined) slide.title = interpolate(step.title, ctx);
    const day = ctx.day;
    if (day) {
      slide.notes = day.headline;
      const evidence = day.items.flatMap((i) => (i.refs ?? []).map((r) => ({ label: i.text, ref: r })));
      if (evidence.length > 0) slide.evidence = evidence;
    }
    slides.push(slide);
  }
  return slides;
}

export type BuildOptions = {
  title?: string;
  /** Defaults to the deck template's own name. */
  now?: string;
};

export function buildDeck(
  days: DayEntry[],
  narrative: Narrative,
  window: Window,
  template: DeckTemplate,
  opts: BuildOptions = {},
): DeckIR {
  const title = opts.title ?? template.name;
  const week = isoWeekLabel(window.start, window.tz);
  const base: StepContext = {
    days, narrative, window, theme: template.theme, title, week, page: 1,
  };

  const slides: Slide[] = [];
  for (const step of template.skeleton) {
    if (!stepApplies(step, base)) continue;
    slides.push(...stepSlides(step, base));
  }

  return {
    meta: {
      title,
      week,
      tz: window.tz,
      generatedAt: opts.now ?? new Date().toISOString(),
    },
    template,
    slides,
  };
}
