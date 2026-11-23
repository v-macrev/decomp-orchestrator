import { posix } from 'node:path';

/**
 * Upstream spells repository includes from the reconstruction root (`#include "skyrim/x/Y.h"`).
 * Such an include only resolves when the unit compiles with `/Ireconstruction`, which a unit asks
 * for by naming a `-root-includes` recipe (`// Recipe: reconstruction/recipes/<name>-root-includes.json`;
 * the first recipe path in the source wins, the way CI finds it). A unit whose own code is fine can
 * stop compiling when a header it includes is rewritten that way upstream. This finds those units
 * and points them at the matching recipe, which differs from theirs only by that include root.
 */

export const UNIT_RECIPE = /\breconstruction\/recipes\/[a-zA-Z0-9_.-]+\.json/;
const INCLUDE = /^[ \t]*#[ \t]*include[ \t]*"([^"<>\n]+)"/gm;
const ROOT = 'reconstruction';

function hasRootFlag(flags: unknown): boolean {
  if (!Array.isArray(flags)) return false;
  return flags.some((f, i) => f === '/Ireconstruction' || f === '-Ireconstruction' || ((f === '/I' || f === '-I') && flags[i + 1] === ROOT));
}

function parseRecipe(text: string | null): { flags?: unknown } | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text) as unknown;
    return j && typeof j === 'object' ? (j as { flags?: unknown }) : null;
  } catch {
    return null;
  }
}

/**
 * Whether `unit`'s include closure has a quoted include that the compiler's own search (the
 * including file's directory, then the directories of the files that included it, innermost
 * first) cannot find, but the reconstruction root can. Returns the first such include.
 */
export async function needsRootInclude(unit: string, read: (path: string) => Promise<string | null>, limit = 400): Promise<string | null> {
  const seen = new Set<string>();
  const exists = new Map<string, boolean>();
  const text = new Map<string, string | null>();
  const load = async (p: string) => {
    if (!text.has(p)) text.set(p, await read(p));
    exists.set(p, text.get(p) !== null);
    return text.get(p)!;
  };
  const has = async (p: string) => (exists.has(p) ? exists.get(p)! : (await load(p)) !== null);
  // Depth-first, carrying the stack of including files' directories.
  const walk = async (file: string, dirs: string[]): Promise<string | null> => {
    if (seen.has(file) || seen.size >= limit) return null;
    seen.add(file);
    const src = await load(file);
    if (src === null) return null;
    const stack = [posix.dirname(file), ...dirs];
    for (const m of src.matchAll(INCLUDE)) {
      const inc = m[1]!.replace(/\\/g, '/');
      let found: string | null = null;
      for (const d of stack) {
        const cand = posix.normalize(d === '.' ? inc : `${d}/${inc}`);
        if (!cand.startsWith('..') && (await has(cand))) {
          found = cand;
          break;
        }
      }
      if (!found) {
        const rooted = posix.normalize(`${ROOT}/${inc}`);
        if (!rooted.startsWith('..') && (await has(rooted))) return inc;
        continue; // a toolchain header, or missing altogether: not ours to fix
      }
      const deeper = await walk(found, stack);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(unit, []);
}

/**
 * The unit source with its recipe switched to the `-root-includes` variant when its includes need
 * the reconstruction root and its recipe lacks it; null when nothing needs to change (or no such
 * variant exists, in which case the compiler reports the include as before).
 */
export async function withRootIncludeRecipe(
  unit: string,
  source: string,
  read: (path: string) => Promise<string | null>,
  fallbackRecipe: string | null,
): Promise<{ content: string; change: string } | null> {
  const named = UNIT_RECIPE.exec(source)?.[0] ?? null;
  const recipe = named ?? fallbackRecipe;
  if (!recipe) return null;
  const doc = parseRecipe(await read(recipe));
  if (!doc || hasRootFlag(doc.flags)) return null;
  const inc = await needsRootInclude(unit, async (p) => (p === unit ? source : read(p)));
  if (!inc) return null;
  const variant = recipe.replace(/\.json$/, '-root-includes.json');
  const v = parseRecipe(await read(variant));
  if (!v || !hasRootFlag(v.flags)) return null;
  let content: string;
  if (named) {
    content = source.replace(named, variant);
  } else {
    // After the leading includes, not in the header: CI takes the first recipe path anywhere in
    // the source, while a header line would count toward the lint's six-line header budget.
    const lines = source.split('\n');
    const isInclude = (l: string) => /^\s*#\s*include\b/.test(l);
    const first = lines.findIndex(isInclude);
    let at = first;
    while (at >= 0 && at + 1 < lines.length && isInclude(lines[at + 1]!)) at++;
    lines.splice(at < 0 ? lines.length : at + 1, 0, `// Recipe: ${variant}`);
    content = lines.join('\n');
  }
  return { content, change: `named recipe ${variant}: "${inc}" (included through its headers) resolves only from the reconstruction root` };
}
