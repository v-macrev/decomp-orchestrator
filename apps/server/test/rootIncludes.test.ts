import { describe, expect, it } from 'vitest';
import { needsRootInclude, withRootIncludeRecipe } from '../src/repo/rootIncludes.js';

const PLAIN = 'reconstruction/recipes/msvc-o2.json';
const ROOTED = 'reconstruction/recipes/msvc-o2-root-includes.json';
const recipes: Record<string, string> = {
  [PLAIN]: JSON.stringify({ flags: ['/nologo', '/c', '/O2'] }),
  [ROOTED]: JSON.stringify({ flags: ['/nologo', '/c', '/O2', '/Ireconstruction'] }),
};

/** The upstream case: the unit includes its header, which includes a layout header upstream rewrote to root-relative spelling. */
const tree = (layoutInclude: string): Record<string, string> => ({
  ...recipes,
  'reconstruction/skyrim/magic/Dual.h': '#pragma once\n#include "ValueLayout.h"\n',
  'reconstruction/skyrim/magic/ValueLayout.h': '#pragma once\n#include <cstdint>\n#include "ActiveLayout.h"\n',
  'reconstruction/skyrim/magic/ActiveLayout.h': `#pragma once\n#include ${layoutInclude}\n`,
  'reconstruction/skyrim_shared/tempeffects/Controller.h': '#pragma once\n',
});
const reader = (files: Record<string, string>) => async (p: string) => files[p] ?? null;
const UNIT = 'reconstruction/skyrim/magic/Dual.cpp';
const SOURCE = '// Source exposure: mixed.\n// Code origin: original\n#include "Dual.h"\n#include "ValueLayout.h"\nvoid f() {}\n';

describe('root-includes recipe', () => {
  it('finds an include only the reconstruction root resolves, through the unit\'s headers', async () => {
    expect(await needsRootInclude(UNIT, reader({ ...tree('"skyrim_shared/tempeffects/Controller.h"'), [UNIT]: SOURCE }))).toBe('skyrim_shared/tempeffects/Controller.h');
    // The old parent-relative spelling resolves from the including file's directory.
    expect(await needsRootInclude(UNIT, reader({ ...tree('"../../skyrim_shared/tempeffects/Controller.h"'), [UNIT]: SOURCE }))).toBeNull();
  });

  it('follows the compiler\'s search through the directories of the including files', async () => {
    const files = {
      'reconstruction/a/U.cpp': '#include "../b/H.h"\n',
      'reconstruction/b/H.h': '#include "Sibling.h"\n', // only in a/, the includer's directory
      'reconstruction/a/Sibling.h': '',
    };
    expect(await needsRootInclude('reconstruction/a/U.cpp', reader(files))).toBeNull();
  });

  it('adds the recipe line after the includes, outside the header', async () => {
    const r = await withRootIncludeRecipe(UNIT, SOURCE, reader(tree('"skyrim_shared/tempeffects/Controller.h"')), PLAIN);
    expect(r?.content).toBe(`// Source exposure: mixed.\n// Code origin: original\n#include "Dual.h"\n#include "ValueLayout.h"\n// Recipe: ${ROOTED}\nvoid f() {}\n`);
    expect(r?.change).toMatch(/skyrim_shared\/tempeffects\/Controller\.h/);
  });

  it('switches a recipe the unit names, and leaves units that need nothing alone', async () => {
    const named = SOURCE.replace('// Code origin: original\n', `// Code origin: original\n// Recipe: ${PLAIN}\n`);
    const r = await withRootIncludeRecipe(UNIT, named, reader(tree('"skyrim_shared/tempeffects/Controller.h"')), null);
    expect(r?.content).toBe(named.replace(PLAIN, ROOTED));
    // Already the root-includes recipe, no fallback recipe known, or nothing rooted: no change.
    expect(await withRootIncludeRecipe(UNIT, named.replace(PLAIN, ROOTED), reader(tree('"skyrim_shared/tempeffects/Controller.h"')), null)).toBeNull();
    expect(await withRootIncludeRecipe(UNIT, SOURCE, reader(tree('"skyrim_shared/tempeffects/Controller.h"')), null)).toBeNull();
    expect(await withRootIncludeRecipe(UNIT, SOURCE, reader(tree('"../../skyrim_shared/tempeffects/Controller.h"')), PLAIN)).toBeNull();
  });

  it('changes nothing when the recipe has no root-includes variant', async () => {
    const files = tree('"skyrim_shared/tempeffects/Controller.h"');
    delete files[ROOTED];
    expect(await withRootIncludeRecipe(UNIT, SOURCE, reader(files), PLAIN)).toBeNull();
  });
});
