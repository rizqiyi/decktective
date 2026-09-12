/**
 * Locate the package root without depending on the file layout.
 *
 * Source and compiled output sit at different depths (`src/x.ts` vs
 * `dist/src/x.js`), and a hardcoded `../..` is correct for exactly one of them.
 * Walking up to the nearest `package.json` works for both — which matters
 * because assets (templates, fonts, skills) live at the package root and are
 * resolved from here.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export function findPackageRoot(startUrl = import.meta.url) {
    let dir = dirname(fileURLToPath(startUrl));
    for (let hops = 0; hops < 8; hops++) {
        if (existsSync(join(dir, "package.json")))
            return dir;
        const parent = resolve(dir, "..");
        if (parent === dir)
            break;
        dir = parent;
    }
    throw new Error(`could not locate package.json above ${startUrl}`);
}
