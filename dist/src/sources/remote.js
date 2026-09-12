/**
 * Resolve whatever the user pointed at into a local repository path.
 *
 * A person asking for a deck says "this repo" or pastes a GitHub URL — not a
 * cache path. So `--repo` accepts a URL, an `owner/repo` shorthand, or a local
 * directory, and this decides what to do:
 *
 *   - remote  -> clone once into the cache dir, then `fetch --prune` on reuse.
 *   - local   -> use it as-is, but fail early if it is not a git work tree.
 *
 * Clones never land in the project or session directory; the design record calls
 * for a cache that is reused across runs, so a weekly rebuild is cheap.
 */
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);
export class RepoError extends Error {
    constructor(message) {
        super(message);
        this.name = "RepoError";
    }
}
const SCHEME = /^(https?:\/\/|ssh:\/\/|git:\/\/|git@)/;
/** `owner/repo`, optionally `.git` — GitHub/GitLab shorthand, not a local path. */
const SHORTHAND = /^[\w.-]+\/[\w.-]+(\.git)?$/;
const gitOk = async (dir) => {
    try {
        await run("git", ["-C", dir, "rev-parse", "--git-dir"]);
        return true;
    }
    catch {
        return false;
    }
};
/**
 * Expand a leading `~` before resolving.
 *
 * `resolve()` does not expand it, so `~/code/app` would otherwise be treated as
 * a relative path and looked up inside the current directory — which is exactly
 * how a user writes a path.
 */
const expandHome = (p) => {
    if (p === "~")
        return homedir();
    if (p.startsWith("~/"))
        return join(homedir(), p.slice(2));
    return p;
};
const pathExists = async (p) => {
    try {
        await stat(p);
        return true;
    }
    catch {
        return false;
    }
};
/** `https://github.com/o/r.git` and `git@github.com:o/r.git` -> `r`. */
export function repoNameFromUrl(url) {
    const withoutGit = url.replace(/\.git$/, "").replace(/\/$/, "");
    const tail = withoutGit.split(/[/:]/).filter(Boolean).pop() ?? "repo";
    return tail.replace(/[^\w.-]/g, "-");
}
/**
 * Turn a user-supplied reference into a usable local work tree.
 *
 * Order matters: an existing local path always wins, so `owner/repo` only means
 * "remote" when it is not something on disk.
 */
export async function resolveRepo(input, opts = {}) {
    const cacheDir = opts.cacheDir ?? join(homedir(), ".cache", "decktective", "repos");
    const raw = expandHome(input.trim());
    if (raw === "")
        throw new RepoError("no repository given");
    const asLocal = isAbsolute(raw) ? raw : resolve(raw);
    const localExists = await pathExists(asLocal);
    const looksRemote = SCHEME.test(raw) || (SHORTHAND.test(raw) && !localExists);
    if (!looksRemote) {
        if (!localExists)
            throw new RepoError(`no such directory: ${asLocal}`);
        if (!(await gitOk(asLocal))) {
            throw new RepoError(`${asLocal} is not a git repository (no .git work tree)`);
        }
        return { path: asLocal, id: basename(asLocal), source: raw, cloned: false, fetched: false };
    }
    const url = SCHEME.test(raw)
        ? raw
        : `https://github.com/${raw.replace(/\.git$/, "")}.git`;
    const name = repoNameFromUrl(url);
    const dir = join(cacheDir, name);
    await mkdir(cacheDir, { recursive: true });
    if (await pathExists(join(dir, ".git"))) {
        if (opts.offline === true) {
            return { path: dir, id: name, source: raw, cloned: false, fetched: false };
        }
        try {
            await run("git", ["-C", dir, "fetch", "--prune", "--quiet"], { timeout: 120_000 });
        }
        catch (err) {
            // A stale cache beats no deck, but say so rather than pretending it is fresh.
            throw new RepoError(`could not refresh ${url}: ${err instanceof Error ? err.message : String(err)}. ` +
                `Pass --offline to use the existing clone at ${dir}.`);
        }
        return { path: dir, id: name, source: raw, cloned: false, fetched: true };
    }
    try {
        await run("git", ["clone", "--quiet", url, dir], { timeout: 600_000 });
    }
    catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new RepoError(`could not clone ${url}: ${detail}. ` +
            `For a private repository, make sure your git credentials work for it.`);
    }
    return { path: dir, id: name, source: raw, cloned: true, fetched: false };
}
