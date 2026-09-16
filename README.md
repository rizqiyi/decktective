# decktective

Turn a git repo's activity into a weekly PPTX, by filling your own template.

**Run it:**

```bash
node src/cli.ts --repo https://github.com/owner/name --preset last --out out -y
open out/*.pptx
```

Takes about 10 seconds offline, or 1–2 minutes with a model. Requires Node ≥ 26.

---

## Install

Three options, easiest first:

1. **As a pi/omp package** (once published)
   ```bash
   pi install npm:decktective
   ```
   Then ask in plain language — no commands, no paths.

2. **As a local extension** — one line in `~/.omp/agent/config.yml`:
   ```yaml
   extensions:
     - /absolute/path/to/decktective
   ```
   Naming the package directory loads its extension entry **and** its `agents/` and `skills/` folders.

3. **As a plain checkout** — clone it and run `node src/cli.ts` directly. No install step.

For option 3, install deps first:

```bash
npm install
```

## Run it

### Plain language (recommended)

Once installed as a package or extension, just say what you want:

> make me a pptx for this repo from Jan 5 to Jan 12

> weekly deck for https://github.com/owner/name, last week

The agent works out the parameters, **asks for anything missing** — in one message, not one question at a time — then builds it. It resolves relative dates and states them back before running.

### Command line

```bash
# This week
node src/cli.ts --repo . --preset this --out out -y

# An explicit window (ISO instants with an offset; end is EXCLUSIVE)
node src/cli.ts --repo . \
  --start 2026-01-05T00:00:00+07:00 \
  --end 2026-01-12T00:00:00+07:00 \
  --tz Asia/Jakarta --out out -y

# Fill your own template
node src/cli.ts --repo . --preset last \
  --pptx-template templates/template1.pptx --out out -y

# No model: fully deterministic, nothing leaves the machine
node src/cli.ts --repo . --preset last --offline --out out -y
```

`--repo` accepts a URL, an `owner/repo`, or a folder path. Remote repos clone once into `~/.cache/decktective/repos/`, then refresh on later runs.

## Workflow

```
git (local or URL)
  ↓  fetch activity
DayEntry[]              numbers frozen here, from git
  ↓  group into work items      ← model, or deterministic
  ↓  articulate                 ← model, or deterministic
  ↓  review & validate          ← loops back on failure
DeckIR
  ↓  fill the .pptx template
PPTX
```

Five things worth knowing:

1. **The model groups and names; the code counts.** Churn, files, commits and impact are computed from git. A number absent from the facts fails the build.
2. **Commit count and change magnitude are separate axes.** A day with 3 commits and +4,120 lines is not a day with 34 small commits. Day profiles (`burst`, `heavy`, `drop`, `rename`, `scattered`) encode that.
3. **Each stage falls back to a deterministic path** with no model configured, so a deck is always produced.
4. **The output contract is judged, not assumed.** A review gate checks the draft against [`i-have-adhd`](https://github.com/ayghri/i-have-adhd) and retries with guidance.
5. **Some fields cannot come from git** — pull-request numbers, team names. These are reported as gaps, never invented.

## Output

One PPTX, plus a JSON IR beside it:

```
out/2026-01-05_filled.pptx     the deck
out/2026-01-05_2026-W02.json   every number the deck used
```

The deck skeleton: cover → overview → **one slide per active day** → highlights → work-item summary → blockers. Day slides are generated from real dates (1–7 of them), not a fixed Mon–Fri.

## Models

Optional. With a key set, the model groups commits into work items and writes the
narrative. With none, every stage falls back to a deterministic path — and the
deck still builds, so a **blank or sparse deck on a new machine is almost always
a missing key or an empty window, not a broken install.**

### Set a key

Add one to your shell profile, then open a new terminal:

```bash
# CommandCode gateway — glm, grok, deepseek, qwen, kimi, gpt
echo 'export COMMANDCODE_API_KEY=sk-...' >> ~/.zshrc

# or OpenAI
echo 'export OPENAI_API_KEY=sk-...' >> ~/.zshrc

# or Anthropic
echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.zshrc

source ~/.zshrc
```

Verify it is visible:

```bash
printenv COMMANDCODE_API_KEY | head -c 8; echo "…"
```

### Pick a model

```bash
node src/cli.ts --repo . --preset this --llm commandcode/deepseek/deepseek-v4-flash -y
node src/cli.ts --repo . --preset this --llm openai/gpt-5 -y
node src/cli.ts --repo . --preset this --llm anthropic/claude-sonnet-5 -y
```

| Provider | Key env var | Example `--llm` |
|---|---|---|
| CommandCode | `COMMANDCODE_API_KEY` | `commandcode/deepseek/deepseek-v4-flash` |
| OpenAI | `OPENAI_API_KEY` | `openai/gpt-5` |
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-5` |

With no key set, the tool runs offline automatically — nothing leaves the machine.

### CommandCode model IDs

The gateway wants the **bare** model id, with no provider prefix:

```
deepseek/deepseek-v4-flash     ✅   (not commandcode/deepseek/…)
z-ai/glm-5.3-flash             ✅
xai/grok-4.5                   ✅
```

The `--llm` value's first path segment is the provider name; everything after it
is passed to that provider untouched. To list what a gateway actually serves:

```bash
curl -sS https://api.commandcode.ai/provider/v1/models \
  -H "Authorization: Bearer $COMMANDCODE_API_KEY" | head -40
```

### Adding a gateway

One entry in `KNOWN_PROVIDERS` in `src/llm/provider.ts` — a base URL, a wire
protocol (`openai` covers any OpenAI-compatible gateway), and the env var holding
its key.

### If the deck comes out empty

1. **No commits in the window.** The tool says `no activity in the window`. Ask
   for a week that has commits — a repo with 2025 history asked for "this week"
   in 2026 is legitimately empty.
2. **A private repo failed to clone.** Look for a clone error; the tool names the
   URL it could not reach.
3. **No key set**, so the narrative is deterministic and terse — install a key
   above for the full version.
4. **Wrong timezone.** `--tz` governs day bucketing; the wrong zone can move
   commits out of the window.

## Templates

The deck is **filled into a .pptx** — your file, your branding.

```bash
# Use the one that ships
node src/cli.ts --repo . --preset this --pptx-template templates/template1.pptx -y

# Ask a model to learn YOUR template (once), then reuse that plan free, offline
node src/cli.ts --template-outline --pptx-template my.pptx
node src/cli.ts --learn-template  --pptx-template my.pptx --llm commandcode/deepseek/deepseek-v4-flash
node src/cli.ts --repo . --preset this --pptx-template my.pptx \
  --manifest ~/.cache/decktective/manifests/my.manifest.json -y
```

A model cannot read a `.pptx`, so it is given a **shape outline** instead — shape ids, positions, sizes, placeholder text. It returns a **manifest** (which shape gets which data), which is validated and then executed by the same deterministic filler. The plan is cached, so learning happens once.

## Commands

| Flag | Effect |
|---|---|
| `--repo <url\|path>` | Repository. URL, `owner/repo`, or local path |
| `--preset this\|last\|4w` | Relative window |
| `--start` / `--end` | Explicit ISO instants; `--end` is exclusive |
| `--tz <zone>` | IANA timezone. Default `Asia/Jakarta` |
| `--branch <ref>` | Branch, tag or ref to walk. Default: the repo HEAD |
| `--all` | Walk **every** ref instead of one line of history |
| `--include-merges` | Count merge commits too |
| `-v`, `--verbose` | Show the pipeline: stage timings, every model call, the grouped work items, each review verdict |
| `--out <dir>` | Output directory. Default `out` |
| `--title <text>` | Deck title |
| `--exclude <prefixes>` | Path **prefixes** removed from churn (not globs) |
| `--pptx-template <file>` | Fill this template instead of generating slides |
| `--manifest <file>` | Use a learned plan for that template |
| `--template-outline` | Print a template's shape outline and exit |
| `--learn-template` | Derive + cache a plan for a template, then exit |
| `--llm <provider>/<model>` | Model for the pipeline stages |
| `--offline` | No model at all |
| `--pptx-only` / `--pdf-only` | Emit one format |
| `-y`, `--yes` | Never prompt; use the default window |

Template mode emits **PPTX only** — producing PDF from a `.pptx` would need LibreOffice, which this project does not depend on.

### Seeing the work

```bash
decktective --repo . --preset this --verbose -y
```

```
  · repo: . (local)
  · window: 2026-09-14T00:00:00+07:00 .. 2026-09-21T00:00:00+07:00  tz=Asia/Jakarta
  · model: commandcode/deepseek/deepseek-v4-flash
  · pipeline (group → articulate → review) …
  · llm commandcode/deepseek/deepseek-v4-flash ← 1885 chars (json)
  · llm deepseek/deepseek-v4-flash → 565 chars in 8757ms
  · llm commandcode/deepseek/deepseek-v4-flash ← 8314 chars (json)
  · llm deepseek/deepseek-v4-flash → 545 chars in 11944ms
  · review attempt 1: aligned
  · work items (8):
  ·     High   feat      3 refs  Export pipeline moved off the main thread
  · resolve layout (10 slides) — 34ms
  · plan: 10 slides, 52 draw ops
  · emit pptx — 21ms
  · emit pdf — 42ms
```

Model calls are the slow, costly, occasionally-failing part of a run — without this, the only sign of one is a pause. The review call dominates: on a real repo it took ~12s of a ~50s run at 8.3k prompt chars.

### Repos whose default branch is merge-only

If `master` only receives merges and the work lives on feature branches, the default walk reports **0 commits** — it uses `--first-parent --no-merges`, which cannot see that shape:

| Flags | Sees |
|---|---|
| *(default)* | 1 of 4 — first-parent, non-merge only |
| `--include-merges` | 2 of 4 — the merge commits too |
| `--all` | 3 of 4 — every non-merge commit across all refs |
| `--all --include-merges` | 4 of 4 — everything (`git rev-list --count --all`) |

`--all` drops `--first-parent`, which is meaningless across refs and would hide the very work it exists to surface.

## Development

```bash
npm test          # 68 tests, ~1.5s, offline
npm run typecheck # must be clean
node scripts/calibrate-profiles.mjs ~/code/your-repo   # check the day classifier
node scripts/preview-pptx.mjs out/*.pptx 3 /tmp/p.png  # LOOK at a slide
```

### Verify by looking, not by extracting

Text extraction passes while layout is broken. A deleted panel and overflowing text both extract as perfectly good text. Before reporting a deck as done:

```bash
pdftotext out/*.pdf -                     # is the text real?
node scripts/preview-pptx.mjs out/*.pptx 3 /tmp/p.png
```

Then open the PNG. If you cannot look, say so.

## Troubleshooting

**"No commits recorded" / an empty deck.** Either the window has no activity, or the clone is shallow. Re-clone without `--depth`.

**Wrong day boundaries.** Days bucket on *author* date; `--since`/`--until` filter on *committer* date. Squashes and rebases move work across days, and the tool warns when they diverge.

**Churn numbers look wrong.** Vendored and generated files inflate them. `--exclude dist/,package-lock.json` — prefixes, not globs.

**"summary shows N of M work items".** The summary table is full. The rest are still in the day slides.

**A day profile you never see.** `burst` needs ≥8 commits. Run the calibration script above to check the thresholds against your repos.
