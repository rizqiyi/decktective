/**
 * Deck construction: facts + narrative -> DeckIR.
 *
 * Fixed skeleton, variable bodies (deliberately boring week to week):
 *   title -> agenda -> headline metrics -> per-day -> themes
 *   -> risks/blockers -> next week -> appendix
 */
import type {
  Block, DayEntry, DeckIR, LayoutId, MetricItem, Narrative,
  Slide, Theme, Window,
} from "../ir/types.ts";
import { DEFAULT_THEME } from "../theme.ts";
import { plural } from "../narrative/template.ts";

const MAX_BULLETS = 6;
const MAX_BULLET_WORDS = 7;

const num = (n: number): string => n.toLocaleString("en-US");

/** Hard budget: a bullet is one line the reader can absorb. */
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

const text = (t: string, emphasis?: "normal" | "muted" | "accent"): Block =>
  ({ kind: "text", text: t, emphasis });

const bullets = (items: string[], refs?: string[][]): Block => ({
  kind: "bullets",
  items: items.map((t, i) => ({ text: t, refs: refs?.[i] })),
});

function titleSlide(window: Window, ir: { title: string; week: string }): Slide {
  const tz = window.tz;
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, day: "2-digit", month: "short", year: "numeric",
    }).format(new Date(iso));
  return {
    layout: "title",
    title: ir.title,
    slots: {
      title: text(ir.title),
      subtitle: text(`${fmt(window.start)} \u2013 ${fmt(window.end)}  \u00b7  ${tz}  \u00b7  ${ir.week}`, "muted"),
    },
  };
}

function metricsSlide(n: Narrative, days: DayEntry[]): Slide {
  const commits = days.reduce((a, d) => a + d.metrics.commits, 0);
  const added = days.reduce((a, d) => a + d.metrics.additions, 0);
  const removed = days.reduce((a, d) => a + d.metrics.deletions, 0);
  const active = days.filter((d) => d.metrics.commits > 0).length;

  const items: MetricItem[] = [
    { label: "Commits", value: commits.toLocaleString("en-US") },
    { label: "Added", value: `+${added.toLocaleString("en-US")}` },
    { label: "Removed", value: removed === 0 ? "0" : `-${removed.toLocaleString("en-US")}` },
    { label: "Active days", value: `${active}/${days.length || 0}` },
  ];

  // Commit count and churn are separate axes; the per-day slide keeps both visible.
  const perDay = days
    .filter((d) => d.metrics.commits > 0)
    .map((d) => `${d.date}  ${plural(d.metrics.commits, "commit")}  ` +
      `+${d.metrics.additions.toLocaleString("en-US")}/-${d.metrics.deletions.toLocaleString("en-US")}`);

  return {
    layout: "metrics",
    title: "Headline",
    slots: {
      heading: text("Headline"),
      metrics: { kind: "metrics", items },
      breakdown: bullets(perDay.map((l) => clampBullet(l, 10))),
      note: text(clampBullet(n.summary, 20), "muted"),
    },
  };
}

function agendaSlide(n: Narrative): Slide {
  const items = [
    ...n.days.map((d) => `${d.date} — ${clampBullet(d.headline)}`),
  ].slice(0, MAX_BULLETS);
  return {
    layout: "agenda",
    title: "The week",
    slots: {
      heading: text("The week"),
      bullets: bullets(items),
    },
  };
}

function daySlides(n: Narrative): Slide[] {
  return n.days.map((d) => {
    const items = d.items.slice(0, MAX_BULLETS).map((i) => clampBullet(i.text));
    const extra = d.items.length - items.length;
    const meta = `${plural(d.metrics.commits, "commit")}  \u00b7  ` +
      `+${d.metrics.additions.toLocaleString("en-US")}/-${d.metrics.deletions.toLocaleString("en-US")}`;
    const refs = d.items.slice(0, MAX_BULLETS).flatMap((i) => (i.refs ? [i.refs] : []));
    return {
      layout: "bullets" as LayoutId,
      title: d.date,
      slots: {
        heading: text(`${d.date}  \u00b7  ${d.profile}`, undefined),
        bullets: bullets(
          [...items, ...(extra > 0 ? [`\u2026and ${extra} more (see appendix)`] : []), meta],
          refs,
        ),
      },
      evidence: d.items.flatMap((i) =>
        (i.refs ?? []).map((r) => ({ label: i.text, ref: r }))),
      notes: d.headline,
    };
  });
}

function themesSlide(n: Narrative): Slide | null {
  if (n.themes.length === 0) return null;
  return {
    layout: "bullets",
    title: "Themes",
    slots: {
      heading: text("Themes"),
      bullets: bullets(n.themes.slice(0, MAX_BULLETS).map((t) => `${t.title} (${t.refs.length})`)),
    },
    evidence: n.themes.flatMap((t) => t.refs.map((r) => ({ label: t.title, ref: r }))),
  };
}

function listSlide(title: string, items: string[], fallback: string): Slide | null {
  if (items.length === 0) return null;
  return {
    layout: "bullets",
    title,
    slots: {
      heading: text(title),
      bullets: bullets(items.slice(0, MAX_BULLETS).map((i) => clampBullet(i, 12))),
    },
  };
}

function appendixSlides(days: DayEntry[]): Slide[] {
  const rows = days.flatMap((d) =>
    d.items.flatMap((i) => (i.refs ?? []).map((r) => ({ label: `${d.date}  ${clampBullet(i.text, 9)}`, ref: r.slice(0, 10) }))),
  );
  if (rows.length === 0) return [];
  const PER_PAGE = 22;
  const out: Slide[] = [];
  for (let i = 0; i < rows.length; i += PER_PAGE) {
    const page = rows.slice(i, i + PER_PAGE);
    out.push({
      layout: "appendix",
      title: `Appendix ${out.length + 1}`,
      slots: {
        heading: text(`Appendix ${out.length + 1} \u2014 evidence`),
        evidence: { kind: "evidence", rows: page },
      },
    });
  }
  return out;
}

export type BuildOptions = {
  title?: string;
  theme?: Theme;
  now?: string;
};

export function buildDeck(
  days: DayEntry[],
  narrative: Narrative,
  window: Window,
  opts: BuildOptions = {},
): DeckIR {
  const theme = opts.theme ?? DEFAULT_THEME;
  const title = opts.title ?? "Weekly Deck";
  const week = isoWeekLabel(window.start, window.tz);

  const slides: Slide[] = [
    titleSlide(window, { title, week }),
    agendaSlide(narrative),
    metricsSlide(narrative, days),
    ...daySlides(narrative),
  ];

  const themes = themesSlide(narrative);
  if (themes) slides.push(themes);

  const risks = listSlide("Risks & blockers", narrative.risks, "");
  if (risks) slides.push(risks);

  const next = listSlide("Next week", narrative.nextWeek, "");
  if (next) slides.push(next);

  slides.push(...appendixSlides(days));

  return {
    meta: {
      title,
      week,
      tz: window.tz,
      generatedAt: opts.now ?? new Date().toISOString(),
    },
    theme,
    slides,
  };
}
