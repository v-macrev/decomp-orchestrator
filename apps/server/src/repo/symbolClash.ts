// A name has one address in a unit. `sr compare` binds names for the packet's own functions only, so
// a candidate can match while needing, at another address, a name that an accepted function of the
// same unit also references: each passes alone, and the project's bot, which compares every function
// of the unit in one map, then fails the accepted one.

/** One name that a packet's function and an accepted function of its unit need at different addresses. */
export interface SymbolClash {
  symbol: string;
  /** The packet's function and the address its passing compare bound the name to. */
  rva: string;
  address: string;
  /** The accepted function and the address its match record holds for the name. */
  acceptedRva: string;
  acceptedAddress: string;
}

/**
 * For each sr task, the clashes of its last compare's object with the accepted functions its unit
 * lists (`// 0x<rva>` lines). A name counts only where this object's code for both functions
 * references it, so a candidate that stopped the accepted function using the name is clean. Skipped:
 * static names (numbered per object), and names the unit's own records already bind to several
 * addresses (the project accepted those). cwd: the tree; argv: JSON {tasksDir, tasks: [srTaskId]}.
 */
export const SYMBOL_CLASH_PY = [
  'import json, os, re, sys',
  'from pathlib import Path',
  "sys.path[:0] = ['tools', 'tools/verifier']",
  'import bind',
  'try:',
  '    import record_store',
  '    read = record_store.read_text',
  'except ImportError:',
  '    read = lambda p: Path(p).read_text()',
  'a = json.loads(sys.argv[1])',
  'num = lambda v: v if isinstance(v, int) else int(str(v), 16)',
  // rvas are ints in the symbol maps and "0x…" in the provenance and the task
  "bound = lambda symbols, n: num(symbols[n]['rva']) if isinstance(symbols.get(n), dict) and 'rva' in symbols[n] else None",
  'def refs(obj, section):',
  "    return {t.name for _, t in bind.outgoing(obj, section) if t.storage == bind.STORAGE_EXTERNAL}",
  'def check(d):',
  "    task = json.loads((d / 'task.json').read_text())",
  "    last = json.loads((d / 'last-compare.json').read_text())",
  "    obj = bind.CoffObject((d / 'runs' / os.path.basename(last['private_dir']) / 'candidate.obj').read_bytes())",
  "    symbols = json.loads((d / 'symbols.json').read_text())['symbols']",
  '    defined = bind.defined_functions(obj)',
  "    own = {num(f['rva']): f.get('symbol') for f in task['functions']}",
  "    text = Path(task['compiled']).read_text(encoding='utf-8-sig', errors='replace')",
  "    marked = {int(m, 16) for m in re.findall(r'^\\s*//\\s*0x([0-9A-Fa-f]+)(?=\\s|$)', text, re.M)}",
  "    reports = Path('reports') / task['build_id']",
  '    accepted, several = [], {}',
  '    for rva in sorted(marked - set(own)):',
  '        try:',
  "            record = json.loads(read(reports / f'0x{rva:x}.json'))",
  '        except FileNotFoundError:',
  '            continue',
  "        symbol = record['runs'][0]['report']['function']['symbol']",
  "        names = json.loads(read(Path(record['symbol_map']['path'])))['symbols']",
  "        names = {n: num(e['rva']) for n, e in names.items() if 'rva' in e}",
  '        names.setdefault(symbol, rva)',
  '        accepted.append((rva, symbol, names))',
  "        if '/unit-symbols/' in record['symbol_map']['path']:",
  '            for n, at in names.items(): several.setdefault(n, set()).add(at)',
  '    out = []',
  '    for rva, symbol in own.items():',
  '        if symbol not in defined: continue',
  '        mine = refs(obj, defined[symbol])',
  '        for other, name, names in accepted:',
  '            if name not in defined: continue',
  '            for n in sorted(mine & (refs(obj, defined[name]) | {name})):',
  '                here, there = bound(symbols, n), names.get(n)',
  '                if here is None or there is None or here == there or len(several.get(n, ())) > 1: continue',
  "                out.append({'symbol': n, 'rva': hex(rva), 'address': hex(here), 'acceptedRva': hex(other), 'acceptedAddress': hex(there)})",
  "    return {'clashes': out, 'accepted': len(accepted)}",
  'result = {}',
  "for tid in a['tasks']:",
  '    try:',
  "        result[tid] = check(Path(a['tasksDir']) / tid)",
  '    except Exception as exc:',
  "        result[tid] = {'error': (type(exc).__name__ + ': ' + str(exc))[:200]}",
  'print(json.dumps(result))',
].join('\n');

/** What the check said for one sr task: its clashes, or why it could not be made. */
export function symbolClashesOf(result: unknown): { clashes: SymbolClash[]; error: string | null } {
  const r = result as { clashes?: unknown; error?: unknown } | null | undefined;
  if (!r || typeof r !== 'object') return { clashes: [], error: 'no result' };
  if (!Array.isArray(r.clashes)) return { clashes: [], error: typeof r.error === 'string' ? r.error : 'no result' };
  const keys = ['symbol', 'rva', 'address', 'acceptedRva', 'acceptedAddress'] as const;
  return { clashes: r.clashes.filter((c): c is SymbolClash => !!c && keys.every((k) => typeof (c as Record<string, unknown>)[k] === 'string')), error: null };
}

/** One clash in words; starts with the packet's own function, as compare findings do. */
export function describeClash(c: SymbolClash): string {
  return `${c.rva} needs ${c.symbol} at ${c.address}, and ${c.acceptedRva}, accepted upstream in this unit, needs the same name at ${c.acceptedAddress}`;
}
