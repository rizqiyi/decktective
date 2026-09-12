/**
 * The IR's type contract. `DeckIR` is the product; emitters are dumb.
 * Every other module depends on this file, so it is the one place types are defined.
 */

/** Calendar date in the deck's declared timezone. `YYYY-MM-DD`. */
export type IsoDate = string;
/** Full ISO 8601 instant with offset, e.g. `2026-09-07T00:00:00+07:00`. */
export type IsoInstant = string;
/** IANA timezone identifier, e.g. `Asia/Jakarta`. */
export type TimeZone = string;

/** Half-open interval `[start, end)` in a single declared timezone. */
export type Window = {
  start: IsoInstant;
  end: IsoInstant;
  tz: TimeZone;
};

export type ItemKind =
  | "feat" | "fix" | "refactor" | "chore" | "docs"
  | "test" | "perf" | "build" | "ci" | "style"
  | "revert" | "other";

export type DayItem = {
  /** Human-readable, already-articulated. Never raw `wip`. */
  text: string;
  /**
   * The commit message body, when the author wrote one. Often the only place
   * the *why* of a change is recorded, so it is the raw material a model
   * articulates a work item summary from.
   */
  body?: string;
  kind: ItemKind;
  /** Commit SHAs / PR ids backing this item. Kept for traceability. */
  refs?: string[];
  additions?: number;
  deletions?: number;
  files?: number;
};

/**
 * Independent measurement axes. Commit count and change magnitude are
 * deliberately NOT collapsed: they disagree, and the disagreement is signal.
 */
export type DayMetrics = {
  commits: number;
  additions: number;
  deletions: number;
  filesTouched: number;
  /** additions + deletions */
  grossChurn: number;
  /** additions - deletions (signed) */
  netChurn: number;
  /** grossChurn / max(filesTouched, 1) */
  concentration: number;
  medianCommitSize: number;
  /** largest single commit's churn / grossChurn */
  maxCommitShare: number;
};

export type DayProfile =
  | "quiet" | "heavy" | "drop" | "rename" | "burst" | "scattered" | "steady";

/** The cache/watermark unit: one JSON per (sourceId, date, tz). */
export type DayEntry = {
  date: IsoDate;
  sourceId: string;
  source: "git" | "manual";
  items: DayItem[];
  metrics: DayMetrics;
  profile?: DayProfile;
  /** Per-day problems: author/committer divergence, excluded paths. Repo-level
   * issues come from `SourceAdapter.diagnostics` instead. */
  warnings?: string[];
};

// ---------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------

export type WorkItemImpact = "Major" | "Medium" | "Small";
export type WorkItemStatus = "Done" | "In progress" | "Blocked";

/**
 * A coherent piece of work spanning one or more commits, days, or repos.
 *
 * This is the unit a reader thinks in ("the sidebar redesign"), as opposed to a
 * commit. Grouping is semantic and may be model-assisted, but every NUMBER here
 * is computed from the referenced commits — a model chooses which commits
 * belong together and what to call them, never how much they changed.
 */
export type WorkItem = {
  /** Stable id derived from the first ref, so it survives re-runs. */
  id: string;
  title: string;
  type: ItemKind;
  /** sourceIds this work touched. */
  repos: string[];
  /** Commit SHAs backing the item — the traceability anchor. */
  refs: string[];
  days: IsoDate[];
  additions: number;
  deletions: number;
  files: number;
  impact: WorkItemImpact;
  status: WorkItemStatus;
  /** One-line description of what changed. */
  summary?: string;
};

/** What a model may decide about a work item; everything else is computed. */
export type WorkItemDraft = {
  title: string;
  type: ItemKind;
  refs: string[];
  /** One or two sentences, articulated from the commits themselves. */
  summary?: string;
  status?: WorkItemStatus;
};

// ---------------------------------------------------------------------------
// Narrative
// ---------------------------------------------------------------------------

export type DayNarrative = {
  date: IsoDate;
  headline: string;
  items: DayItem[];
  profile: DayProfile;
  metrics: DayMetrics;
};

export type ThemeCluster = {
  title: string;
  /** Refs of the items clustered under this theme. */
  refs: string[];
};

export type Narrative = {
  days: DayNarrative[];
  themes: ThemeCluster[];
  summary: string;
  risks: string[];
  nextWeek: string[];
};

/**
 * Turns facts into words. Pure function in spirit: `facts -> narrative`.
 * `LlmNarrative` uses the harness; `TemplateNarrative` is deterministic and offline.
 */
export interface NarrativeEngine {
  narrate(facts: DayEntry[], window: Window): Promise<Narrative>;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type CollectOpts = {
  /** Path prefixes to exclude from churn, e.g. `dist/`, `bun.lock`. */
  exclude?: string[];
  includeMerges?: boolean;
  detectRenames?: boolean;
  /** Suppress whitespace-only changes (`git -w`). Reported, never silent. */
  ignoreWhitespace?: boolean;
  /**
   * Skip the churn pass entirely, returning commit counts only. The window
   * picker probes 12 weeks of density before the user chooses, so this keeps
   * that probe cheap. Metrics other than `commits` are zero.
   */
  commitsOnly?: boolean;
};

export interface SourceAdapter {
  readonly id: string;
  readonly kind: "git" | "manual";
  collect(window: Window, opts?: CollectOpts): Promise<DayEntry[]>;
  /**
   * Repo-level problems that apply regardless of the window, e.g. a shallow
   * clone. Kept separate from per-day warnings because an empty window would
   * otherwise swallow them — which is exactly when they matter most.
   */
  diagnostics?(opts?: CollectOpts): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// DeckIR
// ---------------------------------------------------------------------------

export type LayoutId =
  | "title" | "agenda" | "metrics" | "bullets"
  | "timeline" | "hero" | "appendix";

export type TextBlock = {
  kind: "text";
  text: string;
  emphasis?: "normal" | "muted" | "accent";
};

export type BulletItem = { text: string; refs?: string[] };
export type BulletBlock = { kind: "bullets"; items: BulletItem[] };

export type MetricItem = { label: string; value: string; sub?: string };
export type MetricBlock = { kind: "metrics"; items: MetricItem[] };

export type EvidenceRow = { label: string; ref?: string };
export type EvidenceBlock = { kind: "evidence"; rows: EvidenceRow[] };

export type Block = TextBlock | BulletBlock | MetricBlock | EvidenceBlock;

/** Commit hashes -> clickable appendix. */
export type Evidence = { label: string; ref?: string; url?: string };

export type Slide = {
  layout: LayoutId;
  /** Slot keys are layout-defined. */
  slots: Record<string, Block>;
  title?: string;
  notes?: string;
  evidence?: Evidence[];
};

/**
 * Design tokens. One token table drives all three backends so PPTX and PDF
 * cannot drift; geometry is authored in inches and converted once per emitter.
 */
export type Theme = {
  colors: {
    bg: string;
    fg: string;
    muted: string;
    accent: string;
    rule: string;
  };
  fonts: {
    /** Family name used by satori and referenced in PPTX. */
    family: string;
    /** Concrete TTF paths — needed for measurement and pdfkit embedding. */
    regular: string;
    bold: string;
  };
  type: {
    titlePt: number;
    headingPt: number;
    bodyPt: number;
    captionPt: number;
  };
  grid: {
    cols: number;
    rows: number;
    marginIn: number;
    gutterIn: number;
  };
  canvas: {
    widthIn: number;
    heightIn: number;
  };
};

export type DeckMeta = {
  title: string;
  /** Human week label, e.g. `2026-W37`. */
  week: string;
  tz: TimeZone;
  generatedAt: IsoInstant;
};

export type DeckIR = {
  meta: DeckMeta;
  /**
   * The template that produced this deck. Carried in the IR so a deck is
   * self-describing: it can be re-rendered without the template file, and two
   * runs of the same template are byte-comparable.
   */
  template: DeckTemplate;
  slides: Slide[];
};

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

export type SlotRole =
  | "title" | "heading" | "body" | "caption" | "metrics" | "evidence" | "hero";

/**
 * A layout slot, expressed in GRID coordinates rather than inches.
 *
 * Grid coordinates keep templates resolution-independent: the same template
 * renders at any canvas size, and changing the theme's grid re-flows every
 * layout without editing slots.
 */
export type SlotSpec = {
  key: string;
  role: SlotRole;
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  /** Block kinds this slot may receive. Anything else fails the build. */
  accepts: Array<Block["kind"]>;
};

export type LayoutSpec = {
  id: LayoutId;
  slots: SlotSpec[];
};

/**
 * Where a slot's content comes from. Small on purpose: every kind maps to
 * something the pipeline already computes, so a generated template can only
 * recombine real data — it cannot invent a new data source.
 */
export type FillSpec =
  | { kind: "text"; text: string; emphasis?: "normal" | "muted" | "accent" }
  | { kind: "deck-title" }
  | { kind: "window-label" }
  | { kind: "summary" }
  | { kind: "agenda" }
  | { kind: "metrics" }
  | { kind: "per-day-breakdown" }
  | { kind: "day-heading" }
  | { kind: "day-items" }
  | { kind: "themes" }
  | { kind: "risks" }
  | { kind: "next-week" }
  | { kind: "evidence" };

/** Emit this step once per active day instead of once per deck. */
export type StepRepeat = "per-day";

export type StepWhen =
  | "always" | "has-themes" | "has-risks" | "has-next-week" | "has-evidence";

export type TemplateStep = {
  /** Stable id — used in errors and to make diffs readable. */
  id: string;
  layout: LayoutId;
  /** Supports `{date}`, `{profile}`, `{week}`, `{page}`. */
  title?: string;
  repeat?: StepRepeat;
  when?: StepWhen;
  fill: Record<string, FillSpec>;
};

export type DeckTemplate = {
  id: string;
  name: string;
  version: number;
  theme: Theme;
  layouts: LayoutSpec[];
  /** Ordered slide plan. Optional steps are dropped when their data is empty. */
  skeleton: TemplateStep[];
};
