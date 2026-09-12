/**
 * Weekly template fill plan.
 *
 * Maps facts + narrative onto the placeholders of a specific corporate
 * template (`templates/template1.pptx`). The template was authored in a slide
 * editor, so it has literal `[placeholder]` text and no stable shape names —
 * the binding keys below ARE the placeholders.
 *
 * The day section is why this exists: the template ships five hardcoded day
 * slides, but a week can have any number of active days. The run is collapsed
 * to one prototype and cloned to the real count (max 7), so Mon–Fri is no
 * longer baked in.
 *
 * Fields we genuinely cannot derive from git — PR numbers, "why it mattered" —
 * are deliberately NOT filled. A visible placeholder asks a human to finish the
 * job; an invented value would be a lie in a document people present.
 */
import { PptxPackage } from "./package.js";
import { fillSlide, removeShapesById, readShapes, setShapeText, cloneShapes, setShapeBox, } from "./fill.js";
import { plural } from "../narrative/template.js";
/** Hard ceiling: a week has seven days. */
export const MAX_DAYS = 7;
const KIND_LABEL = {
    feat: "Feature", fix: "Bugfix", refactor: "Refactor", chore: "Chore",
    docs: "Docs", test: "Test", perf: "Performance", build: "Build",
    ci: "CI", style: "Style", revert: "Revert", other: "Other",
};
/**
 * Template boxes are sized for a phrase, not a commit subject. Truncate at a
 * word boundary so text wraps predictably instead of overflowing the shape.
 */
function clamp(text, max) {
    const t = text.trim();
    if (t.length <= max)
        return t;
    const cut = t.slice(0, max);
    const lastSpace = cut.lastIndexOf(" ");
    return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}\u2026`;
}
/** Commit subjects are the source of item titles; keep them slide-sized. */
const ITEM_TITLE_MAX = 58;
const NARRATIVE_MAX = 92;
const NARRATIVE_LABEL_MAX = 64;
/**
 * The summary table's work-item column is the narrowest text box in the deck.
 * Its own budget keeps titles from wrapping into the rows beneath.
 */
const TABLE_CELL_MAX = 34;
/** The work items that touch a given day, heaviest first. */
function itemsForDay(workItems, date, n) {
    return workItems
        .filter((w) => w.days.includes(date))
        .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
        .slice(0, n);
}
/** 1 -> 1st, 2 -> 2nd, 3 -> 3rd, 11 -> 11th, 21 -> 21st. */
function ordinal(n) {
    const v = n % 100;
    const suffix = ["th", "st", "nd", "rd"][(v - 20) % 10] ?? ["th", "st", "nd", "rd"][v] ?? "th";
    return `${n}${suffix}`;
}
/**
 * Full heading for a day: "Wednesday 29th Jan 2026".
 *
 * A bare weekday name is ambiguous in a deck that may cover more than one week,
 * and it reads as a template placeholder. The date is the anchor a reader
 * actually uses to place the work. Noon UTC avoids a midnight shift changing
 * the weekday.
 */
function dayHeading(date) {
    const d = new Date(`${date}T12:00:00Z`);
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "UTC", weekday: "long", month: "short", year: "numeric",
    }).formatToParts(d);
    const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("weekday")} ${ordinal(d.getUTCDate())} ${get("month")} ${get("year")}`;
}
const shortDate = (iso, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" })
    .format(new Date(iso));
function rangeLabel(window) {
    // `end` is exclusive; show the last day a human recognises.
    const last = new Date(new Date(window.end).getTime() - 1000);
    const year = new Intl.DateTimeFormat("en-US", { timeZone: window.tz, year: "numeric" })
        .format(new Date(window.start));
    return `${shortDate(window.start, window.tz)} \u2013 ${shortDate(last.toISOString(), window.tz)}, ${year}`;
}
/**
 * Choose which days the deck shows.
 *
 * Normally every active day fits, because a window is a week. Over a longer
 * window it cannot, so keep the busiest days and report the rest rather than
 * silently truncating to the first week.
 */
function selectDays(days, max = MAX_DAYS) {
    const active = days.filter((d) => d.metrics.commits > 0);
    if (active.length <= max)
        return { shown: active, dropped: [] };
    const ranked = [...active].sort((a, b) => b.metrics.commits - a.metrics.commits || a.date.localeCompare(b.date));
    const kept = new Set(ranked.slice(0, max).map((d) => d.date));
    return {
        shown: active.filter((d) => kept.has(d.date)),
        dropped: active.filter((d) => !kept.has(d.date)),
    };
}
// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------
function coverBindings(window) {
    return { "[Sep 7 \u2013 Sep 11]": rangeLabel(window) };
}
function overviewBindings(days, narrative, workItems) {
    const repos = new Set(days.map((d) => d.sourceId));
    const commits = days.reduce((a, d) => a + d.metrics.commits, 0);
    const top = [...workItems]
        .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
        .slice(0, 3);
    const themes = narrative.themes.slice(0, 3).map((t) => `${t.title} (${t.refs.length})`);
    return {
        "[3]": String(repos.size),
        // "Meaningful pieces of work" is work items, not a commit count — the whole
        // point of the template's framing.
        "[5]": String(workItems.length || days.reduce((a, d) => a + d.items.length, 0)),
        "[27]": String(commits),
        "[Main feature / delivery completed or progressed]": clamp(top[0]?.title ?? themes[0] ?? "", NARRATIVE_MAX),
        "[Important bug / stability improvement]": clamp(top[1]?.title ?? themes[1] ?? "", NARRATIVE_MAX),
        "[Cross-repo or technical work that had meaningful impact]": clamp(top[2]?.title ?? themes[2] ?? "", NARRATIVE_MAX),
    };
}
/**
 * Heading, badge, and evidence text for one day.
 *
 * The work item cards are NOT bound here. Their placeholder text repeats across
 * cards, which works for the two the template was authored with and breaks at
 * five, so `layoutDayCards` writes them by shape id instead.
 */
function dayBindings(day, index) {
    const refs = day.items.flatMap((i) => i.refs ?? []).slice(0, 6).map((r) => r.slice(0, 7));
    return {
        // Day heading and badge.
        // The authored placeholder is a weekday name; we replace it with the date.
        "1. MONDAY": dayHeading(day.date),
        "Kickoff / primary focus": clamp(day.items[0]?.text ?? "", NARRATIVE_LABEL_MAX),
        "03": String(index + 1).padStart(2, "0"),
        // Evidence. Repos/commits/changes/refs come from facts; PR numbers do not.
        "[frontend-web]": day.sourceId,
        "[backend-api]": "",
        "[8 total]": `${day.metrics.commits} total`,
        "[31 files]": plural(day.metrics.filesTouched, "file"),
        // Two runs in one paragraph: the second carries its own separator.
        "[+420 / -110]": ` \u00b7 +${day.metrics.additions.toLocaleString("en-US")} / -${day.metrics.deletions.toLocaleString("en-US")}`,
        "[abc1234 \u2022 def5678]": refs.join(" \u2022 "),
    };
}
/**
 * Template fields that git cannot populate. Reported once per run so the author
 * knows exactly what still needs a human, without a placeholder on every slide.
 */
export const KNOWN_GAPS = [
    "[#142] [#88] and [4]: pull/merge-request numbers need a GitHub/GitLab API, not git",
    "[Why it mattered / outcome]: kept blank unless a commit body states the rationale",
];
function highlightsBindings(workItems) {
    const top = [...workItems]
        .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
        .slice(0, 3);
    const note = (w) => w ? `${KIND_LABEL[w.type]} \u00b7 ${w.impact} \u00b7 ${plural(w.refs.length, "commit")} \u00b7 ${plural(w.files, "file")}` : "";
    return {
        "[Major feature]": clamp(top[0]?.title ?? "", ITEM_TITLE_MAX),
        "[Cross-repo delivery / user impact]": note(top[0]),
        "[Important bugfix]": clamp(top[1]?.title ?? "", ITEM_TITLE_MAX),
        "[Stability / reliability improvement]": note(top[1]),
        "[Technical improvement]": clamp(top[2]?.title ?? "", ITEM_TITLE_MAX),
        "[Maintainability / performance / quality]": note(top[2]),
    };
}
/** Column order of the authored summary rows. */
const SUMMARY_COLUMNS = ["title", "repos", "type", "commits", "impact", "status"];
/**
 * The summary "table" is six text boxes per row, not an `<a:tbl>`. Read it as a
 * grid: each row pairs a band of background panels with a band of text cells
 * 0.15in below, both sorted left-to-right.
 */
function readSummaryRows(shapes) {
    const bands = new Map();
    for (const s of shapes) {
        const key = Math.round(s.y * 100) / 100;
        bands.set(key, [...(bands.get(key) ?? []), s]);
    }
    const bandsOut = [];
    for (const y of [...bands.keys()].sort((a, b) => a - b)) {
        const band = (bands.get(y) ?? []).sort((a, b) => a.x - b.x);
        if (band.length !== SUMMARY_COLUMNS.length)
            continue;
        if (band.every((s) => s.text.trim() === ""))
            continue; // a panel band
        const panelBand = bands.get(Math.round((y - 0.15) * 100) / 100);
        bandsOut.push({
            panelIds: (panelBand ?? []).sort((a, b) => a.x - b.x).map((s) => s.id),
            cellIds: band.map((s) => s.id),
            y,
        });
    }
    // The header band is structurally identical to a data row — six cells with a
    // panel band above — so it is identified by position, not shape. Treating it
    // as data would overwrite the column labels and clone the header.
    return bandsOut.slice(1);
}
/** Bottom of the usable area, in inches; rows below this would run off-slide. */
const SUMMARY_BOTTOM_IN = 5.25;
/**
 * Render the summary table with as many rows as there are work items.
 *
 * Row count follows the work items rather than the four rows the template was
 * authored with: a week with seven items should show seven, not silently drop
 * three. Rows are cloned from the first authored row so formatting is
 * inherited, and truncated only when the slide cannot physically fit them.
 */
function fillSummaryTable(xml, workItems) {
    const authored = readSummaryRows(readShapes(xml));
    if (authored.length === 0) {
        return { xml, rows: 0, truncated: workItems.length, missing: ["summary rows not found"] };
    }
    const first = authored[0];
    const pitch = authored.length > 1 ? authored[1].y - first.y : 0.54;
    const capacity = Math.max(1, Math.floor((SUMMARY_BOTTOM_IN - first.y) / pitch));
    const wanted = Math.min(workItems.length, capacity);
    let out = xml;
    const missing = [];
    // Clone from the LAST authored row, not the first: copies are offset by one
    // pitch each, so copying row 1 would land them exactly on rows 2 and 3.
    // Interleave panel and cell ids so each copy keeps its background behind its
    // text (later shapes paint on top).
    const last = authored[authored.length - 1];
    const sourceIds = [];
    for (let c = 0; c < SUMMARY_COLUMNS.length; c++) {
        const panel = last.panelIds[c];
        const cell = last.cellIds[c];
        if (panel !== undefined)
            sourceIds.push(panel);
        if (cell !== undefined)
            sourceIds.push(cell);
    }
    const rows = authored
        .slice(0, Math.min(authored.length, wanted))
        .map((r) => ({ cellIds: r.cellIds }));
    if (wanted > authored.length) {
        const clone = cloneShapes(out, sourceIds, wanted - authored.length, pitch);
        out = clone.xml;
        for (const created of clone.created) {
            // created arrives as [panel1, cell1, panel2, cell2, ...]
            rows.push({ cellIds: created.filter((_id, i) => i % 2 === 1) });
        }
    }
    if (wanted < authored.length) {
        const drop = authored.slice(wanted).flatMap((r) => [...r.panelIds, ...r.cellIds]);
        const report = removeShapesById(out, drop);
        out = report.xml;
        missing.push(...report.missing);
    }
    const sorted = [...workItems]
        .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
        .slice(0, rows.length);
    for (let r = 0; r < sorted.length; r++) {
        const item = sorted[r];
        const row = rows[r];
        const values = {
            title: clamp(item.title, TABLE_CELL_MAX),
            repos: item.repos.join(" + "),
            type: KIND_LABEL[item.type],
            commits: plural(item.refs.length, "commit"),
            impact: item.impact,
            status: item.status,
        };
        SUMMARY_COLUMNS.forEach((col, c) => {
            const id = row.cellIds[c];
            if (id !== undefined)
                out = setShapeText(out, id, values[col]);
        });
    }
    return {
        xml: out,
        rows: rows.length,
        truncated: Math.max(0, workItems.length - rows.length),
        missing,
    };
}
function closingBindings(narrative) {
    const risks = narrative.risks;
    return {
        "[None]": risks[0] ?? "None",
        "[Dependency / decision]": risks[1] ?? "",
        "[Potential timeline risk]": risks[2] ?? "",
        "[Question / follow-up]": risks[3] ?? "",
    };
}
// ---------------------------------------------------------------------------
// Day cards
// ---------------------------------------------------------------------------
/**
 * Work item cards on a day slide.
 *
 * The template was authored with two hand-placed cards. A day can carry more,
 * so one card is the prototype: card 1's shapes are cloned to the real count and
 * every card — authored or cloned — is then positioned from the same numbers.
 *
 * The "WORK ITEM n" label is not part of the prototype (id 172, and 179 on the
 * authored card 2): at five cards the pitch is 0.83in and the label is one row
 * too many. Labels are removed, not blanked, so no empty box is left behind.
 */
const CARD = {
    /** Card 1, in clone order: panel, title, type, detail, badge panel, badge text. */
    shapes: ["171", "173", "174", "175", "176", "177"],
    /** Card 2: replaced by clones of card 1, so every card shares one prototype. */
    replaced: ["178", "179", "180", "181", "182", "183", "184"],
    /** Card labels, dropped from the authored cards. */
    labels: ["172", "179"],
};
/** A day shows at most this many work items; a sixth card cannot be read. */
const MAX_DAY_CARDS = 5;
/** Vertical band the cards share, top of the first card to bottom of the last. */
const CARD_BAND_TOP_IN = 1.16;
const CARD_BAND_BOTTOM_IN = 5.30;
/** Gap between two stacked card panels. */
const CARD_GAP_IN = 0.08;
/** Rounded-rect panel: template column, inset from the slide's left margin. */
const CARD_PANEL = { x: 0.49, w: 6.19 };
/** Text column, kept clear of the impact badge at x 5.44. */
const CARD_TEXT = { x: 0.71, w: 4.55 };
const CARD_BADGE = { x: 5.44, w: 0.94, h: 0.34, textX: 5.57, textW: 0.68, textDy: 0.09 };
/**
 * Rows inside one card, offset from the panel's top.
 *
 * The authored card stacks a label, a name, a type, and a two-line detail over
 * 1.05in. At five cards only 0.75in is available, so the rows are pulled to
 * three one-line rows and the badge floats beside them. Each height is one line
 * at its font size: these shapes use `spAutoFit`, so a second line would grow
 * the box into the card beneath it.
 */
const CARD_ROWS = {
    title: { dy: 0, h: 0.26 },
    type: { dy: 0.29, h: 0.17 },
    detail: { dy: 0.47, h: 0.17 },
};
/** Height of the row block, used to centre it in a taller (fewer cards) panel. */
const CARD_CONTENT_H_IN = 0.64;
/** A card title is read at a glance; 40 characters hold one line at 12pt. */
const CARD_TITLE_MAX = 40;
/** One line at 8pt across the text column. */
const CARD_SUMMARY_MAX = 70;
/** Pair an id list with its roles; `undefined` when the list is short. */
function cardIds(ids) {
    const [panel, title, type, detail, badge, badgeText] = ids;
    if (panel === undefined || title === undefined || type === undefined ||
        detail === undefined || badge === undefined || badgeText === undefined)
        return undefined;
    return { panel, title, type, detail, badge, badgeText };
}
/**
 * Lay one day's work items out as stacked cards.
 *
 * N cards are spread over the day slide's vertical band with a uniform pitch,
 * so the band is used whatever N is, and anything the day does not need is
 * removed rather than left as an empty panel. Text is written per shape id —
 * not by placeholder — because with five cards the placeholder text repeats.
 */
function layoutDayCards(xml, items) {
    const n = Math.min(items.length, MAX_DAY_CARDS);
    const first = cardIds(CARD.shapes);
    if (first === undefined)
        return { xml, missing: [...CARD.shapes] };
    // The authored card 2 and both labels are never used: card 2 is what the
    // clones replace, and the labels are the row the compact pitch cannot afford.
    // Dropped first, so a day with no work items cannot leave a stray label.
    const drop = removeShapesById(xml, [...CARD.replaced, ...CARD.labels]);
    const missing = [...drop.missing];
    let out = drop.xml;
    // No work items: the slide shows none of the cards, panels included.
    if (n === 0) {
        const report = removeShapesById(out, CARD.shapes);
        return { xml: report.xml, missing: [...missing, ...report.missing] };
    }
    const pitch = (CARD_BAND_BOTTOM_IN - CARD_BAND_TOP_IN) / n;
    const panelH = pitch - CARD_GAP_IN;
    const cards = [first];
    if (n > 1) {
        // Copies are appended in source order and offset one pitch each; the
        // positions below rewrite that offset, so the clone only has to keep order.
        const clone = cloneShapes(out, CARD.shapes, n - 1, pitch);
        out = clone.xml;
        for (const created of clone.created) {
            const ids = cardIds(created);
            if (ids === undefined) {
                missing.push(...created);
                continue;
            }
            cards.push(ids);
        }
    }
    // The content block is centred in the panel, so a day with one or two items
    // reads as a card rather than as text stranded at the top of a tall box.
    const inner = (panelH - CARD_CONTENT_H_IN) / 2;
    const badgeDy = inner + (CARD_CONTENT_H_IN - CARD_BADGE.h) / 2;
    for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        const top = CARD_BAND_TOP_IN + i * pitch;
        out = setShapeBox(out, card.panel, { ...CARD_PANEL, y: top, h: panelH });
        out = setShapeBox(out, card.title, {
            x: CARD_TEXT.x, y: top + inner + CARD_ROWS.title.dy, w: CARD_TEXT.w, h: CARD_ROWS.title.h,
        });
        out = setShapeBox(out, card.type, {
            x: CARD_TEXT.x, y: top + inner + CARD_ROWS.type.dy, w: CARD_TEXT.w, h: CARD_ROWS.type.h,
        });
        out = setShapeBox(out, card.detail, {
            x: CARD_TEXT.x, y: top + inner + CARD_ROWS.detail.dy, w: CARD_TEXT.w, h: CARD_ROWS.detail.h,
        });
        out = setShapeBox(out, card.badge, {
            x: CARD_BADGE.x, y: top + badgeDy, w: CARD_BADGE.w, h: CARD_BADGE.h,
        });
        out = setShapeBox(out, card.badgeText, {
            x: CARD_BADGE.textX, y: top + badgeDy + CARD_BADGE.textDy, w: CARD_BADGE.textW, h: 0.14,
        });
    }
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const card = cards[i];
        if (item === undefined || card === undefined)
            break;
        out = setShapeText(out, card.title, clamp(item.title, CARD_TITLE_MAX));
        out = setShapeText(out, card.type, `Type: ${KIND_LABEL[item.type]}`);
        // No summary means an empty line, not a placeholder repeated on the slide.
        out = setShapeText(out, card.detail, item.summary === undefined ? "" : clamp(item.summary, CARD_SUMMARY_MAX));
        out = setShapeText(out, card.badgeText, item.impact);
    }
    return { xml: out, missing };
}
// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
/** Slide positions in `template1.pptx` (0-based, as authored). */
const SHAPE = {
    slideCount: 11,
    cover: 0,
    overview: 1,
    dayFirst: 2,
    dayLast: 6,
    highlights: 7,
    summary: 8,
    closing: 9,
};
/**
 * Shape ids for the blocks a week may not fill, grouped so they can be removed
 * wholesale. Ids are stable within the template and survive cloning; a
 * re-exported template can change them, which surfaces as a `missing` warning
 * rather than a silently empty box.
 */
const BLOCKS = {
    /** NEXT WEEK: its card panel (481), label and the bullet shape (482, 483). */
    closingNextWeek: ["481", "482", "483"],
};
/** Title text on the closing slide once the next-week block is dropped. */
const CLOSING_TITLE = { from: "Blockers & Next Week", to: "Blockers & Risks" };
/**
 * Geometry for the blockers section once the next-week panel is gone.
 *
 * The authored layout puts blockers in the left half and next week in the right.
 * Removing the right half leaves the text stranded at half width, where a normal
 * sentence wraps and gets truncated — so the section is widened to the full
 * content width, and the stub line gets a second line's worth of height.
 */
const BLOCKERS_BOXES = [
    { id: "477", x: 0.49, w: 9.00 }, // section panel
    { id: "479", x: 0.71, w: 8.56, h: 0.52 },
    { id: "480", x: 0.71, y: 2.34, w: 8.56, h: 1.60 },
];
export async function fillWeeklyTemplate(opts) {
    const pkg = await PptxPackage.load(opts.templatePath);
    const slides = pkg.slides();
    if (slides.length !== SHAPE.slideCount) {
        throw new Error(`${opts.templatePath}: expected ${SHAPE.slideCount} slides, found ${slides.length}; ` +
            `this fill plan targets the shipped weekly template.`);
    }
    const { shown, dropped } = selectDays(opts.days, opts.maxDays ?? MAX_DAYS);
    // Collapse the fixed Mon–Fri run to one prototype, then clone it to the real
    // count. Cloning the growing tail keeps presentation order correct.
    const dayRun = slides.slice(SHAPE.dayFirst, SHAPE.dayLast + 1).map((s) => s.part);
    const prototype = await pkg.collapseRun(dayRun);
    let lastDay = prototype;
    for (let i = 1; i < shown.length; i++)
        lastDay = await pkg.duplicate(lastDay);
    const layout = pkg.slides();
    const unfilled = new Set();
    let filledCount = 0;
    const apply = async (part, bindings) => {
        const report = fillSlide(await pkg.xml(part), bindings);
        pkg.setXml(part, report.xml);
        filledCount += report.filled.length;
        for (const u of report.unfilled)
            unfilled.add(u);
    };
    /** Drop a block the week has no content for, rather than leaving it empty. */
    const drop = async (part, ids, label) => {
        const report = removeShapesById(await pkg.xml(part), ids);
        pkg.setXml(part, report.xml);
        if (report.missing.length > 0) {
            console.log(`  warn: ${label}: ${report.missing.length} shape id(s) not found ` +
                `(${report.missing.join(", ")}); the template may have been re-exported`);
        }
    };
    await apply(layout[SHAPE.cover].part, coverBindings(opts.window));
    await apply(layout[SHAPE.overview].part, overviewBindings(opts.days, opts.narrative, opts.workItems));
    for (let i = 0; i < shown.length; i++) {
        const ref = layout[SHAPE.dayFirst + i];
        if (!ref)
            throw new Error(`missing day slide ${i + 1} after cloning`);
        const day = shown[i];
        // Cards first: they are written by shape id, so `fillSlide` afterwards must
        // not see the card placeholders and report them as unfilled.
        const cards = layoutDayCards(await pkg.xml(ref.part), itemsForDay(opts.workItems, day.date, MAX_DAY_CARDS));
        pkg.setXml(ref.part, cards.xml);
        if (cards.missing.length > 0) {
            console.log(`  warn: day ${day.date}: ${cards.missing.length} card shape id(s) not found ` +
                `(${cards.missing.join(", ")}); the template may have been re-exported`);
        }
        await apply(ref.part, dayBindings(day, i));
    }
    const tail = SHAPE.dayFirst + shown.length;
    await apply(layout[tail].part, highlightsBindings(opts.workItems));
    const summaryPart = layout[tail + 1].part;
    {
        const report = fillSummaryTable(await pkg.xml(summaryPart), opts.workItems);
        pkg.setXml(summaryPart, report.xml);
        if (report.truncated > 0) {
            console.log(`  warn: summary shows ${report.rows} of ${report.rows + report.truncated} work item(s); slide is full`);
        }
        for (const m of report.missing)
            console.log(`  warn: summary table: ${m}`);
    }
    // Next week is out of scope for this report: drop the block, and retitle the
    // slide so the heading does not promise a section that is not there.
    const closing = layout[tail + 2].part;
    await drop(closing, BLOCKS.closingNextWeek, "closing next-week block");
    // Reclaim the space that block occupied.
    {
        let xml = await pkg.xml(closing);
        for (const box of BLOCKERS_BOXES)
            xml = setShapeBox(xml, box.id, box);
        pkg.setXml(closing, xml);
    }
    await apply(closing, {
        ...closingBindings(opts.narrative),
        [CLOSING_TITLE.from]: CLOSING_TITLE.to,
    });
    await pkg.save(opts.outPath);
    return {
        dayCount: shown.length,
        droppedDays: dropped.map((d) => d.date),
        unfilled: [...unfilled].sort(),
        filledCount,
    };
}
