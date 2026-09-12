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
  /** Non-fatal problems: shallow clone, author/committer divergence, excluded paths. */
  warnings?: string[];
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
  theme: Theme;
  slides: Slide[];
};
