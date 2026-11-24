#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Collector for the local skyrim_decomp dashboard. Standard library only.

Contains no network code: every source is a local file, the orchestrator's SQLite database (opened
read-only, without touching its -wal/-shm files) or a git object already fetched into the clone.
Writes only below data/desk. Never opens accounts.json, credential files, packs, objects,
listings (side-by-side/align files) or session logs.

The orchestrator server runs it every `desk.intervalSec` seconds. By hand:

    python collect.py            one run
    python collect.py --watch 60 one run every 60 s
"""
import argparse, collections, datetime as dt, hashlib, json, lzma, os, re, sqlite3, statistics
import subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data' / 'desk'
CACHE = OUT / 'cache'
DETAIL = OUT / 'detail'
DB = ROOT / 'data' / 'real.db'
CONFIG = ROOT / 'config' / 'orchestrator.json'
CLI_SOURCE = ROOT / 'apps' / 'server' / 'src' / 'providers' / 'cli.ts'
REF = 'origin/main'
ME_RVA = re.compile(r'0x[0-9a-f]{5,8}')
NO_CALL = re.compile(r'\(no model call\)')
MATCHED_TASK = ('staged', 'passed', 'withheld', 'set_aside')
TASK_RANK = ['staged', 'passed', 'withheld', 'set_aside', 'gating', 'leased', 'pending', 'dead',
             'quarantined', 'cancelled']

# Text that could be a listing or bytes is dropped, whatever field it came from.
LISTING = re.compile(
    r'\b(mov\w*|lea|xor|and|or|add|sub|call|jmp|j[a-z]{1,2}|test|cmp|push|pop|ret|v?movap\w*)\s+'
    r'(\w+\s+ptr|\[|[re]?[abcd]x\b|[re]?[sd]i\b|r\d+|xmm\d|0x)|(?:\b[0-9a-f]{2}\s){4}|\\x[0-9a-f]{2}', re.I)
BAD_SOURCE = re.compile(r'__asm|_emit\b|\\x[0-9a-f]{2}\\x|(?:0x[0-9a-f]{1,2}\s*,\s*){8}', re.I)
WITHHELD = '[line withheld: it resembled a listing]'


def clean(text, limit=400):
    if not text:
        return None
    lines = []
    for line in str(text).split('\n'):
        line = line.rstrip()
        if line:
            lines.append(WITHHELD if LISTING.search(line) else line)
    return '\n'.join(lines)[:limit] or None


def iso(ms):
    return None if ms is None else int(ms)


def load_json(path, default=None):
    try:
        return json.loads(Path(path).read_text('utf-8'))
    except (OSError, ValueError):
        return default


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(value, separators=(',', ':'), ensure_ascii=False)
    try:
        if path.read_text('utf-8') == data:
            return False
    except OSError:
        pass
    tmp = path.with_suffix('.tmp')
    tmp.write_text(data, 'utf-8')
    os.replace(tmp, path)
    return True


# ---------------------------------------------------------------- sources

class Clone:
    """Read-only access to the WSL clone: git objects through wsl.exe, small files through UNC."""

    def __init__(self, cfg):
        repo = cfg['repo']
        self.path = repo['path']
        self.local = repo.get('localDir') or self.path + '/.local'
        self.distro = (repo.get('host') or {}).get('distro') if os.name == 'nt' else None

    def run(self, args, stdin=None):
        cmd = (['wsl.exe', '-d', self.distro, '-e'] if self.distro else []) + args
        r = subprocess.run(cmd, input=stdin, capture_output=True)
        if r.returncode not in (0, 1):
            raise RuntimeError(f'{args[0]} failed: {r.stderr.decode("utf-8", "replace")[:200]}')
        return r.stdout

    def git(self, *args, stdin=None):
        return self.run(['git', '--no-optional-locks', '-c', 'gc.auto=0', '-c', 'fetch.auto=0', '-C', self.path, *args], stdin)

    def blobs(self, paths, at=f'{REF}:'):
        """{path: bytes or None} for files at REF (full object names with at=''), in one git process."""
        paths = list(dict.fromkeys(paths))
        if not paths:
            return {}
        raw = self.git('cat-file', '--batch', stdin=''.join(f'{at}{p}\n' for p in paths).encode())
        out, i = {}, 0
        for p in paths:
            nl = raw.index(b'\n', i)
            head = raw[i:nl]
            i = nl + 1
            if head.endswith(b'missing'):
                out[p] = None
                continue
            n = int(head.rsplit(b' ', 1)[1])
            out[p] = raw[i:i + n]
            i += n + 1
        return out

    def file(self, posix):
        return Path(rf'\\wsl.localhost\{self.distro}' + posix.replace('/', '\\')) if self.distro else Path(posix)


def open_db():
    """Open the live database without writing to it or its side files."""
    uri = 'file:' + str(DB).replace('\\', '/')
    wal = Path(str(DB) + '-wal')
    try:
        con = sqlite3.connect(uri + '?mode=ro&readonly_shm=1', uri=True)
        con.execute('select 1 from tasks limit 1').fetchone()
        return con, 'live, read-only'
    except sqlite3.Error:
        pass
    if not wal.exists() or wal.stat().st_size == 0:
        con = sqlite3.connect(uri + '?immutable=1', uri=True)
        return con, 'closed database, immutable'
    raise RuntimeError('the orchestrator database has an unmerged WAL and cannot be opened read-only')


PACK = re.compile(r'(reports/[^/]+)/packs/match-[0-9a-f]{3}\.xz')
RECORD = re.compile(r'reports/[^/]+/0x[0-9a-f]+\.json')


def pack_of(path):
    build, name = path.rsplit('/', 1)
    return f'{build}/packs/match-{int(name[2:-5], 16) >> 16:03x}.xz'


def unpack(raw):
    return json.loads(lzma.decompress(raw).decode()) if raw else {}


def match_records(clone, login):
    """{record path: record} at REF for records that mention `login`. Upstream keeps them as one file
    each, or (since its #996) in xz shards; a loose file overrides its packed copy."""
    paths = clone.git('ls-tree', '-r', '--name-only', REF, '--', 'reports/').decode().split()
    packs = [p for p in paths if PACK.fullmatch(p)]
    loose = {p for p in paths if RECORD.fullmatch(p)}
    if not packs and not loose:
        raise RuntimeError(f'no match records found below reports/ on {REF}: their layout changed')
    out = {}
    for p, raw in clone.blobs(packs).items():
        build = PACK.fullmatch(p)[1]
        out.update((f'{build}/{name}', text) for name, text in unpack(raw).items()
                   if login.lower() in text.lower() and f'{build}/{name}' not in loose)
    if loose:
        hits = clone.git('grep', '-l', '-i', login, REF, '--', 'reports/').decode().split()
        out.update(clone.blobs([p for p in (h.split(':', 1)[1] for h in hits) if p in loose]))
    return {k: json.loads(v) for k, v in out.items()}


def names_of(rep):
    return [n.lstrip('@').lower() for n in [m.get('handle') for m in rep.get('matchers') or []] or [rep.get('submitter')] if n]


def first_records(clone, paths):
    """{record path: (date, names)} of each record's first version on REF: its loose file, else the
    first shard commit that holds it."""
    out, cur, found = {}, None, {}
    raw = clone.git('log', '--diff-filter=A', '--format=@%H %cI', '--name-only', REF, '--', *paths).decode() if paths else ''
    for line in raw.splitlines():
        if line.startswith('@'):
            cur = line[1:].split()
        elif line:
            found[line] = cur
    blobs = clone.blobs([f'{c[0]}:{p}' for p, c in found.items()], at='')
    for p, (sha, at) in found.items():
        b = blobs.get(f'{sha}:{p}')
        out[p] = (at, names_of(json.loads(b)) if b else [])
    by_pack = collections.defaultdict(list)
    for p in paths:
        if p not in out:
            by_pack[pack_of(p)].append(p)
    for pack, want in by_pack.items():
        commits = [c.split() for c in clone.git('log', '--reverse', '--format=%H %cI', REF, '--', pack).decode().splitlines()]
        versions = clone.blobs([f'{sha}:{pack}' for sha, _ in commits], at='')
        for sha, at in commits:
            entries = unpack(versions.get(f'{sha}:{pack}'))
            for p in want:
                text = entries.get(p.rsplit('/', 1)[1])
                if text and p not in out:
                    out[p] = (at, names_of(json.loads(text)))
    return out


def upstream(clone, login):
    """Everything derived from the fetched origin/main, cached by commit."""
    sha, when = clone.git('log', '-1', '--format=%H %cI', REF).decode().split()
    key = f'upstream-{sha[:16]}-{login}-v7.json'
    hit = load_json(CACHE / key)
    if hit:
        return hit
    base = ['data/progress.json', 'data/contributors.json', 'data/ready-queue.json', 'data/drafter-claims.json',
            'data/target-hashes/contributor-targets.json', 'data/source-moves.json']
    tree = clone.git('ls-tree', '--name-only', f'{REF}:data/generator-groups').decode().split()
    groups = [f'data/generator-groups/{n}' for n in tree if n.endswith('.json')]
    b = {k: json.loads(v) if v else None for k, v in clone.blobs(base + groups).items()}
    prog = b['data/progress.json']
    fn = {hex(f['rva']): {'s': f['status'], 'n': f['size'], 'o': f.get('owner'), 'name': f.get('name'),
                          'r': f.get('report')} for f in prog['functions']}
    counts = collections.Counter(f['s'] for f in fn.values())
    credited = {}
    by_report = {f['r']: r for r, f in fn.items() if f['r']}
    for p, rep in match_records(clone, login).items():
        if p in by_report and login.lower() in names_of(rep):
            credited[by_report[p]] = {'report': p, 'source': (rep.get('source') or {}).get('compiled')}
    # when each record first appeared on origin/main, and whether it named you then
    first = load_json(CACHE / 'first-records.json', {})  # a record's first version never changes
    first.update(first_records(clone, [c['report'] for c in credited.values() if c['report'] not in first]))
    write_json(CACHE / 'first-records.json', first)
    for c in credited.values():
        c['at'], who = first.get(c['report'], (None, []))
        c['firstYours'] = login.lower() in who
    commits = []
    raw = clone.git('log', REF, '-i', '--author=macrev' if login == 'v-macrev' else f'--author={login}',
                    '--format=%H%x09%cI%x09%s').decode()
    for line in raw.splitlines():
        h, at, subject = line.split('\t', 2)
        pr = re.search(r'\(#(\d+)\)', subject)
        commits.append({'sha': h[:10], 'at': at, 'subject': subject, 'pr': int(pr[1]) if pr else None,
                        'rvas': list(dict.fromkeys(ME_RVA.findall(subject)))})
    tgt, rq = b['data/target-hashes/contributor-targets.json'], b['data/ready-queue.json']
    if 'parts' in tgt:  # since 11-23 the rows live in part files beside the index
        parts = clone.blobs([x['path'] for x in tgt['parts']])
        tgt['functions'] = [r for x in tgt['parts'] for r in json.loads(parts[x['path']])['functions']]
    open_claims = {}
    for c in tgt.get('claims', []):
        for e in c.get('entries', []):
            open_claims[hex(e[0])] = c.get('url')
    moves = b['data/source-moves.json'] or {}
    contrib = (b['data/contributors.json'] or {}).get('contributors', {}).get(login)
    contrib_at = clone.git('log', '-1', '--format=%cI', REF, '--', 'data/contributors.json').decode().strip()
    hit = {
        'sha': sha, 'committedAt': when, 'progressUpdatedAt': prog.get('updated_at'), 'counts': counts,
        'fn': fn, 'credited': credited, 'commits': commits, 'openClaims': open_claims,
        'published': contrib, 'publishedAt': contrib_at,
        'targets': {'snapshot': tgt.get('snapshot_utc'), 'nextCandidates': tgt.get('next_candidate_count'),
                    'underClaim': tgt.get('claim_function_count'), 'claims': len(tgt.get('claims', [])),
                    'offered': [[hex(f['rva']), f.get('size')] for f in tgt.get('functions', [])]},
        'ready': {'progressUpdatedAt': rq.get('progress_updated_at'), 'counts': rq.get('counts'),
                  'entries': [[e['rva'], e['size'], e['blocks'], e['unlocks']] for e in rq.get('entries', [])]},
        'groups': [{'family': b[g]['generator_family'], 'file': g, 'version': b[g].get('generator_version'),
                    'members': [hex(m['rva']) for m in b[g]['members']]} for g in groups if b[g]],
        'moves': moves.get('files', {}), 'moveDirs': moves.get('dirs', {}),
        'drafterClaims': {k.rsplit('-', 1)[1]: v for k, v in (b['data/drafter-claims.json'] or {}).get('claims', {}).items()},
    }
    for old in CACHE.glob('upstream-*.json'):
        old.unlink()
    write_json(CACHE / key, hit)
    return hit


def compare_records(clone):
    """Per-function-folder compare records, re-read only when a file's time or size changed."""
    cache = load_json(CACHE / 'folders.json', {})
    roots = [f'{clone.local}/contrib/tasks', f'{clone.local}/contrib/archive']
    raw = clone.run(['find', *roots, '-type', 'f', '(', '-name', 'task.json', '-o', '-name', 'last-compare.json',
                     '-o', '-name', 'summary.json', ')', '-printf', '%T@\t%s\t%p\n']).decode('utf-8', 'replace')
    folders = collections.defaultdict(list)
    for line in raw.splitlines():
        t, size, p = line.split('\t', 2)
        m = re.match(r'(.*/(?:tasks|archive)/[^/]+)/', p)
        if m:
            folders[m[1]].append((p, t, size))
    out, read = {}, 0
    for folder, files in folders.items():
        sig = hashlib.sha1('|'.join(sorted(f'{p}{t}{s}' for p, t, s in files)).encode()).hexdigest()
        old = cache.get(folder)
        if old and old['sig'] == sig:
            out[folder] = old
            continue
        read += 1
        rec = {'sig': sig, 'fns': {}, 'runs': []}
        for p, t, _ in sorted(files):
            d = load_json(clone.file(p))
            if not isinstance(d, dict):
                continue
            if p.endswith('/task.json'):
                rec['unit'] = d.get('compiled')
                for f in d.get('functions', []):
                    rec['fns'][f['rva']] = {'size': f.get('size'), 'name': f.get('community_name')}
            elif p.endswith('summary.json'):
                for f in d.get('functions', []):
                    pg = (d.get('progress') or {}).get(f['rva']) or {}
                    rec['runs'].append({'rva': f['rva'], 'run': d.get('run'), 'at': int(float(t) * 1000),
                                        'result': f.get('result'), 'reason': f.get('reason'),
                                        'aligned': pg.get('value'), 'total': pg.get('total')})
        out[folder] = rec
    write_json(CACHE / 'folders.json', out)
    return out, read


# ---------------------------------------------------------------- reasons

# First rule whose pattern matches wins. `code` is the Gate Keeper's finding code.
REASONS = [
    ('taken', 'Taken by others', 'text says already matched / matched upstream / no longer published / other open claims',
     re.compile(r'already matched|already has a unit|matched upstream|no longer published|no longer tracked|not in data/progress|other open claim|claimed by', re.I)),
    ('regalloc', 'Register allocation', 'text names register allocation or a register difference',
     re.compile(r'register (alloc|differ|choice)', re.I)),
    ('order', 'Instruction order', 'text names instruction order or scheduling',
     re.compile(r'instruction (order|schedul)|scheduling', re.I)),
    ('flags', 'Needs other compile flags', 'text names MSVC/compile flags as the cause (the comparator\'s generic "…or flags" hint does not count)',
     re.compile(r'compile[r]? flags?|needs other flags|/O[12xd]\b|/GS\b', re.I)),
    ('header', 'Missing header, declaration or layout', 'compile error, missing symbol, or an include the rules refuse',
     re.compile(r'COMPARE_COMPILE_ERROR|COMPARE_FUNCTION_SYMBOL_MISSING|COMPARE_UNDECLARED_ALIAS|error C\d{4}|include-outside-roots|LEAK_INCLUDE')),
    ('size', 'Code shape: wrong length', 'comparator function-size-mismatch',
     re.compile(r'COMPARE_FUNCTION_SIZE_MISMATCH|function-size-mismatch')),
    ('bytes', 'Same length, different code', 'comparator code-byte, relocation-target or unwind-info mismatch; it does not say whether registers, order, types or flags differ',
     re.compile(r'COMPARE_CODE_BYTE_MISMATCH|COMPARE_RELOCATION|COMPARE_UNWIND|byte-mismatch')),
    ('standards', 'Standards refusal', 'Gate Keeper convention, preflight, scope, leak, review or cheat rule',
     re.compile(r'\b(CONV|PREFLIGHT|SCOPE|LEAK|REVIEW|CHEAT)_')),
    ('stopped', 'Run stopped before a verdict', 'run cancelled or the packet was never attempted',
     re.compile(r'run cancelled|no attempt')),
    ('other', 'Other', 'none of the rules above matched', re.compile('')),
]


def categorise(text):
    for key, *_rest, rx in REASONS:
        if rx.search(text):
            return key
    return 'other'


# ---------------------------------------------------------------- collect

def collect():
    started = time.time()
    cfg = load_json(CONFIG)
    login = cfg['runDefaults']['draftedBy']
    clone = Clone(cfg)
    OUT.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(exist_ok=True)
    up = upstream(clone, login)
    folders, folders_read = compare_records(clone)
    claims = load_json(clone.file(f'{clone.local}/contrib/claims.json'), {})
    fetched_at = int(clone.file(clone.path + '/.git/FETCH_HEAD').stat().st_mtime * 1000)
    db, db_mode = open_db()
    db.row_factory = sqlite3.Row
    q = lambda s, *a: db.execute(s, a).fetchall()
    notes = {}

    # provider only; nothing else in the account rows is read
    harness = {r['id']: r['p'] for r in q("select id, json_extract(json,'$.provider') p from accounts")}
    local_models = sorted({r['id'] for r in q("select id, json_extract(json,'$.baseUrl') u from accounts")
                           if re.match(r'https?://(localhost|127\.|\[::1\])', r['u'] or '')})
    runs = {r['id']: dict(r) for r in q('select id,name,status,created_at,started_at,finished_at from runs')}
    tasks = {r['id']: dict(r) for r in q('select id,run_id,unit,functions_json,state,attempts_total,best_exact_bytes,'
                                         'last_verdict_id,updated_at,difficulty,fix_json from tasks')}
    attempts = collections.defaultdict(list)
    for r in q('select id,task_id,n,account_id,model,status,error,started_at,finished_at,tier from attempts order by started_at'):
        attempts[r['task_id']].append(dict(r))
    verdicts = {}
    for r in q('select id,task_id,attempt_id,decision,route,findings_json,compare_json,created_at from verdicts order by created_at'):
        verdicts[r['attempt_id']] = {'id': r['id'], 'task': r['task_id'], 'decision': r['decision'], 'route': r['route'],
                                     'at': r['created_at'], 'findings': json.loads(r['findings_json'] or '[]'),
                                     'compare': json.loads(r['compare_json'] or '[]')}
    events = q('select seq,ts,run_id,task_id,kind,level,msg from events order by ts')
    hold_events = q("select ts,kind,data_json from events where kind in ('batch.packets_withheld','batch.packets_set_aside') order by ts")
    batches = []
    for r in q('select id,seq,status,task_ids_json,detail_json,created_at from pr_batches'):
        d = json.loads(r['detail_json'] or '{}')
        st = d.get('prStatus') or {}
        batches.append({'id': r['id'], 'seq': r['seq'], 'status': r['status'], 'tasks': json.loads(r['task_ids_json']),
                        'functions': d.get('functions'), 'pr': d.get('pr'), 'submittedAt': d.get('submittedAt'),
                        'prState': st.get('state'), 'mergedAt': st.get('mergedAt'), 'createdAt': r['created_at'],
                        'cap': (d.get('rebalanced') or {}).get('max')})

    hold_unit, collisions = {}, {}
    for r in hold_events:
        d = json.loads(r['data_json'] or '{}')
        if r['kind'] == 'batch.packets_set_aside':
            for u, why in (d.get('reasons') or {}).items():
                hold_unit[u] = [d.get('why') or ''] + list(why)
        else:
            for rva, cs in (d.get('collisions') or {}).items():
                collisions[rva] = [c.get('url') for c in cs if c.get('url')]

    # ---- filed: batch functions of submitted PRs, plus commits of yours outside those PRs
    filed, db_prs = {}, set()
    by_task_fns = {t: json.loads(v['functions_json']) for t, v in tasks.items()}
    for b in batches:
        if not b['pr']:
            continue
        num = int(b['pr'].rsplit('/', 1)[1])
        db_prs.add(num)
        for t in b['tasks']:
            for f in by_task_fns.get(t, []):
                filed[f['rva']] = {'pr': num, 'at': b['submittedAt'], 'src': 'orchestrator batch',
                                   'merged': b['prState'] == 'merged'}
    for c in up['commits']:
        if c['pr'] in db_prs:
            continue
        at = int(dt.datetime.fromisoformat(c['at']).timestamp() * 1000)
        for rva in c['rvas']:
            filed.setdefault(rva, {'pr': c['pr'], 'at': at, 'src': 'your commit on origin/main', 'merged': True})

    # A merge re-records every function of the files it touched under the submitter: what someone
    # else (or nobody) was recorded for first, and you never filed, is not your match.
    rerecorded = [r for r, c in up['credited'].items() if r not in filed and not c['firstYours']]
    up['credited'] = {r: c for r, c in up['credited'].items() if r in filed or c['firstYours']}

    # Functions of your merged PRs without a record: still in their unit on main, or in another one?
    unit_of = {f['rva']: tasks[t]['unit'] for t, fns in by_task_fns.items() for f in fns}
    ask = [r for r, f in filed.items() if f['merged'] and r in unit_of and r not in up['credited']
           and (up['fn'].get(r) or {}).get('s') != 'matched']
    marked = collections.defaultdict(set)
    if ask:
        hits = clone.git('grep', '-i', '-E', r'^ *// *(' + '|'.join(ask) + r')\b', REF, '--', 'reconstruction/*.cpp')
        for line in hits.decode('utf-8', 'replace').splitlines():
            _, p, text = line.split(':', 2)
            marked[re.search(r'0x[0-9a-f]+', text.lower())[0]].add(p)
    left_out = {}
    for r in ask:
        unit = up['moves'].get(unit_of[r], unit_of[r])
        if marked[r] and unit not in marked[r]:
            left_out[r] = sorted(marked[r])[0]

    # ---- per function
    fn_tasks = collections.defaultdict(list)
    meta = {}
    for tid, fns in by_task_fns.items():
        for f in fns:
            fn_tasks[f['rva']].append(tid)
            meta[f['rva']] = f
    folder_runs = collections.defaultdict(list)
    folder_meta = {}
    for rec in folders.values():
        for rva, m in rec['fns'].items():
            folder_meta.setdefault(rva, {**m, 'unit': rec.get('unit')})
        for r in rec['runs']:
            folder_runs[r['rva']].append(r)

    universe = set(fn_tasks) | set(filed) | set(up['credited']) | set(claims)
    rows, detail_keys = [], set()
    src_want = {}
    details = {}
    for rva in sorted(universe, key=lambda x: int(x, 16)):
        u = up['fn'].get(rva)
        m = meta.get(rva) or {}
        fm = folder_meta.get(rva) or {}
        size = m.get('size') or (u or {}).get('n') or fm.get('size')
        name = m.get('name') or (u or {}).get('name') or fm.get('name')
        tids = sorted(fn_tasks.get(rva, []), key=lambda t: TASK_RANK.index(tasks[t]['state']))
        task = tasks[tids[0]] if tids else None
        tl = []
        best = None            # (aligned, exact, total, reason)
        first_pass = last_pass = last_call = None
        last_findings = None
        any_pass_compare = False
        for tid in tids:
            for a in attempts[tid]:
                v = verdicts.get(a['id'])
                no_call = bool(a['model'] and NO_CALL.search(a['model']))
                cmp_ = next((c for c in v['compare'] if c.get('rva') == rva), None) if v else None
                codes = [f.get('code') for f in v['findings'] if f.get('severity') == 'block'] if v else []
                if cmp_:
                    if cmp_.get('result') == 'pass':
                        any_pass_compare = True
                    elif cmp_.get('alignedBytes') is not None and cmp_.get('targetSize'):
                        cand = (cmp_['alignedBytes'], cmp_.get('exactBytes') or 0, cmp_['targetSize'], cmp_.get('reason'))
                        best = max(best, cand, key=lambda x: x[:2]) if best else cand
                if v and v['decision'] == 'pass':
                    last_pass = a
                    if not no_call and not first_pass:
                        first_pass = a
                if a['model'] and not no_call:
                    last_call = a
                if v and v['decision'] != 'pass':
                    mine = [f for f in v['findings'] if rva in (f.get('message') or '')]
                    use = mine or [f for f in v['findings'] if f.get('severity') == 'block'] or v['findings']
                    real = [f for f in use if f.get('code') != 'REPEATED_CANDIDATE']
                    if real or not last_findings:
                        last_findings = real or use
                tl.append({'at': iso(a['started_at']), 'end': iso(a['finished_at']), 'n': a['n'], 'model': a['model'],
                           'harness': None if no_call else harness.get(a['account_id']), 'status': a['status'],
                           'decision': v['decision'] if v else None, 'codes': list(dict.fromkeys(codes))[:5],
                           'result': cmp_.get('reason') if cmp_ else None,
                           'aligned': cmp_.get('alignedBytes') if cmp_ else None,
                           'exact': cmp_.get('exactBytes') if cmp_ else None,
                           'target': cmp_.get('targetSize') if cmp_ else None,
                           'verdict': clean(next((f.get('message') for f in (v['findings'] if v else [])
                                                  if rva in (f.get('message') or '')), None)),
                           'error': clean(a['error'], 160) if a['error'] and a['status'] == 'provider_error' else None})
        if not tids:
            for r in sorted(folder_runs.get(rva, []), key=lambda r: r['at']):
                if r['result'] == 'pass':
                    any_pass_compare = True
                elif r.get('aligned') is not None and r.get('total'):
                    cand = (r['aligned'], 0, r['total'], r['reason'])
                    best = max(best, cand, key=lambda x: x[:2]) if best else cand
                tl.append({'at': r['at'], 'n': r['run'], 'model': None, 'harness': None, 'status': 'compare',
                           'decision': r['result'], 'codes': [], 'result': r['reason'], 'aligned': r.get('aligned'),
                           'exact': None, 'target': r.get('total'), 'verdict': None, 'error': None})

        claim = claims.get(rva)
        cred = up['credited'].get(rva)
        f = filed.get(rva)
        upm = bool(u and u['s'] == 'matched')
        matched_local = bool(last_pass) or any(tasks[t]['state'] in MATCHED_TASK for t in tids)
        held, reason_text = None, None
        if cred:
            state = 'verified'
        elif rva in left_out:
            state, reason_text = 'taken', f"left out when PR {f['pr']} was merged: main already has a unit for it ({left_out[rva]})"
        elif f:
            state = 'uncredited' if upm else 'awaiting' if f['merged'] else 'filed'
        elif task and task['state'] in MATCHED_TASK:
            if upm:
                state, reason_text = 'taken', f"already matched upstream ({u['o']})"
            elif task['state'] == 'withheld':
                state = 'taken'
                reason_text = 'other open claim or pull request: ' + ', '.join(collisions.get(rva, [])[:3]) if rva in collisions \
                    else 'withheld: another function of its unit is named by an open claim (other open claim)'
            else:
                state = 'matched'
                held = task['state']
                if held == 'set_aside':
                    why = hold_unit.get(task['unit'])
                    mine_ = [w for w in why or [] if rva in w]
                    reason_text = clean('\n'.join(mine_ or ['whole unit: ' + w for w in why or [] if w]), 600) \
                        or 'set aside; no reason recorded'
        elif task and task['state'] in ('pending', 'leased', 'gating'):
            state = 'queued'
        elif task:
            state = 'released'
            if last_findings:
                reason_text = clean('\n'.join(f"{x.get('code')}: {x.get('message')}" for x in last_findings), 700)
            if task['state'] == 'cancelled':
                reason_text = 'run cancelled' + ('; last verdict: ' + reason_text if reason_text else '; no attempt reached a verdict')
        elif claim:
            state = 'taken' if upm else 'claim'
            reason_text = f"already matched upstream ({u['o']})" if upm else None
        else:
            state = 'claim'
        dead_msgs = []
        if state == 'released' and task['state'] == 'dead':
            dead_msgs = [e['msg'] for e in events if e['task_id'] == task['id'] and e['kind'] == 'task.dead']
            if dead_msgs and 'infrastructure' in dead_msgs[-1]:
                reason_text = clean(dead_msgs[-1])
        # categories: an operator-cancelled packet with a verdict is sorted by that verdict
        cat = None
        if state in ('released', 'taken') or held == 'set_aside':
            t = reason_text or ''
            cat = categorise(t.replace('run cancelled; last verdict: ', '') if 'last verdict' in t else t)

        model = model_src = hrn = None
        route = None
        if tids:
            who = first_pass or (last_call if not matched_local else None) or last_call
            model = who['model'] if who else None
            hrn = harness.get(who['account_id']) if who else None
            model_src = 'attempt'
            lp = (last_pass or {}).get('model') or ''
            route = ('spliced rebuild' if lp.startswith('splice') else 'stored candidate' if lp.startswith('stored')
                     else 'model worker' if any(x['model'] for x in tl) else None)
        else:
            route = 'outside the orchestrator' if (f or cred or claim) else None
            if claim and claim.get('model') and claim['model'] != 'decomp-orchestrator':
                model, model_src = claim['model'], 'claim record'
        times = [x['at'] for x in tl if x['at']]
        row = {
            'rva': rva, 'va': hex(0x140000000 + int(rva, 16)), 'name': name, 'size': size, 'state': state,
            'held': held, 'unit': (task or {}).get('unit') or fm.get('unit') or (cred or {}).get('source'),
            'route': route, 'model': model, 'modelSource': model_src, 'harness': hrn,
            'attempts': len(tl) if tids else (len(tl) or None),
            'nearAligned': round(100 * best[0] / best[2], 1) if best and not any_pass_compare else None,
            'nearExact': round(100 * best[1] / best[2], 1) if best and not any_pass_compare and tids else None,
            'nearReason': best[3] if best and not any_pass_compare else None,
            'bytePass': any_pass_compare, 'matchedLocal': matched_local,
            'reason': reason_text, 'category': cat,
            'first': min(times) if times else None, 'last': max(times) if times else None,
            'filedAt': f['at'] if f else None, 'pr': f['pr'] if f else None, 'filedSource': f['src'] if f else None,
            'verifiedAt': int(dt.datetime.fromisoformat(cred['at']).timestamp() * 1000) if cred and cred.get('at') else None,
            'upstream': (u or {}).get('s'), 'upstreamOwner': (u or {}).get('o'),
            'claim': (claim or {}).get('status'), 'claimUrl': (claim or {}).get('url'),
            'difficulty': (task or {}).get('difficulty'), 'run': runs[task['run_id']]['name'] if task else None,
            'passedAt': last_pass['finished_at'] if last_pass else None,
        }
        rows.append(row)
        details[rva] = {'rva': rva, 'timeline': tl, 'source': None, 'sourceNote': None}
        # source: the passing attempt's files for the unit; else the last attempt's; else upstream's current file
        pick = last_pass
        if not pick and tids:
            pick = next((a for t in tids for a in reversed(attempts[t]) if a['id'] in verdicts), None)
        if pick:
            src_want[rva] = pick['id']
    rowby = {r['rva']: r for r in rows}

    # ---- sources
    ids = list(set(src_want.values()))
    src_files = {}
    for i in range(0, len(ids), 400):
        part = ids[i:i + 400]
        for r in q(f"select id,files_json from attempts where id in ({','.join('?' * len(part))})", *part):
            src_files[r['id']] = json.loads(r['files_json'] or '[]')
    up_paths = {}
    for rva, r in rowby.items():
        if rva in src_want:
            continue
        rep = (up['fn'].get(rva) or {}).get('r')
        p = (up['credited'].get(rva) or {}).get('source') or r['unit']
        if p and (rva in filed or rva in up['credited']):
            q_ = up['moves'].get(p, p)
            for a, b_ in up['moveDirs'].items():
                if q_.startswith(a + '/'):
                    q_ = b_ + q_[len(a):]
            up_paths[rva] = [p, q_]
    blobs = clone.blobs([x for v in up_paths.values() for x in v]) if up_paths else {}
    for rva, d in details.items():
        if rva in src_want:
            files = src_files.get(src_want[rva], [])
            ok = [x for x in files if re.search(r'\.(cpp|h)$', x['path']) and not BAD_SOURCE.search(x['content'])]
            ok.sort(key=lambda x: (x['path'] != rowby[rva]['unit'], x['path']))
            d['source'] = [{'path': x['path'], 'content': x['content'][:65536]} for x in ok[:4]] or None
            d['sourceNote'] = ('accepted candidate' if rowby[rva]['matchedLocal'] else 'last candidate that reached a verdict; it did not match')
            if len(ok) < len(files):
                d['sourceNote'] += '; a file was withheld (not .cpp/.h, or it contained byte-like data)'
        elif rva in up_paths:
            hit = next((p for p in up_paths[rva] if blobs.get(p)), None)
            if hit and not BAD_SOURCE.search(blobs[hit].decode('utf-8', 'replace')):
                d['source'] = [{'path': hit, 'content': blobs[hit].decode('utf-8', 'replace')[:65536]}]
                d['sourceNote'] = f'current file on fetched {REF}; it may hold other contributors\' functions too'
            else:
                d['sourceNote'] = 'the file named in the report no longer exists under that path'
        else:
            d['sourceNote'] = 'no candidate source recorded'
        write_json(DETAIL / f'{rva}.json', d)
        detail_keys.add(f'{rva}.json')
    for old in DETAIL.glob('*.json'):
        if old.name not in detail_keys:
            old.unlink()

    # ---- aggregates
    now = int(time.time() * 1000)
    today = dt.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000
    day = 86400000
    st = collections.Counter(r['state'] for r in rows)
    by = lambda s: [r for r in rows if r['state'] == s]
    nbytes = lambda rs: sum(r['size'] or 0 for r in rs)
    verified = by('verified')
    ver_t = [r['verifiedAt'] for r in verified if r['verifiedAt']]
    cum, series, cb = 0, [], 0
    for r in sorted((r for r in verified if r['verifiedAt']), key=lambda r: r['verifiedAt']):
        cum += 1
        cb += r['size'] or 0
        series.append({'t': r['verifiedAt'], 'n': cum, 'bytes': cb})
    cohort = [r for r in rows if r['rva'] in fn_tasks]
    funnel = {
        'screened': len(cohort),
        'claimed': sum(1 for r in cohort if r['attempts']),
        'matched': sum(1 for r in cohort if r['matchedLocal']),
        'filed': sum(1 for r in cohort if r['filedAt'] and r['pr']),
        'verified': sum(1 for r in cohort if r['filedAt'] and r['state'] == 'verified'),
        'takenAfterMatch': sum(1 for r in cohort if r['matchedLocal'] and r['state'] == 'taken' and not r['filedAt']),
    }
    all_att = [a for l in attempts.values() for a in l]
    passes = [v for v in verdicts.values() if v['decision'] == 'pass']
    hour = lambda ms: dt.datetime.fromtimestamp(ms / 1000)
    att_h, pass_h = [0] * 24, [0] * 24
    grid = [[0] * 24 for _ in range(7)]
    for a in all_att:
        h = hour(a['started_at'])
        att_h[h.hour] += 1
        grid[h.weekday()][h.hour] += 1
    for v in passes:
        pass_h[hour(v['at']).hour] += 1

    def reason_table(sel):
        out = []
        for key, label, rule, _ in REASONS:
            rs = [r for r in sel if r['category'] == key]
            if rs:
                out.append({'key': key, 'label': label, 'rule': rule, 'count': len(rs), 'bytes': nbytes(rs)})
        return sorted(out, key=lambda x: -x['count'])
    released = by('released')
    heldrows = [r for r in rows if r['state'] == 'taken' or r['held'] == 'set_aside']

    # ---- models; token columns are gated on complete harness records
    flags = CLI_SOURCE.read_text('utf-8') if CLI_SOURCE.exists() else ''
    no_persist = {'claude_cli': "'--no-session-persistence'" in flags, 'codex_cli': "'--ephemeral'" in flags}
    models = {}
    unmetered = collections.Counter()
    for r in q("select model,status,count(*) n from attempts where output_tokens=0 and model is not null and model not like '%(no model call)%' group by 1,2"):
        unmetered[r['model']] += r['n']
    calls = collections.Counter(a['model'] for a in all_att if a['model'] and not NO_CALL.search(a['model']))
    for (mdl, h) in sorted({(r['model'], r['harness']) for r in rows if r['model']} |
                           {(a['model'], harness.get(a['account_id'])) for a in all_att if a['model'] and not NO_CALL.search(a['model'])},
                           key=str):
        mine = [r for r in rows if r['model'] == mdl and r['harness'] == h]
        mat = [r for r in mine if r['matchedLocal'] or r['state'] in ('verified', 'uncredited', 'awaiting', 'filed')]
        models[f'{mdl}|{h}'] = {
            'model': mdl, 'harness': h, 'matched': len(mat), 'bytes': nbytes(mat),
            'medianSize': statistics.median([r['size'] for r in mat if r['size']]) if any(r['size'] for r in mat) else None,
            'releases': sum(1 for r in mine if r['state'] == 'released'),
            'verified': sum(1 for r in mine if r['state'] == 'verified'),
            'calls': sum(1 for a in all_att if a['model'] == mdl and harness.get(a['account_id']) == h) or None,
            'uncredited': sum(1 for r in mine if r['state'] == 'uncredited'),
        }
    models = {k: v for k, v in models.items() if v['matched'] or v['releases'] or v['calls']}
    tokens_ok = not any(no_persist.get(harness.get(a['account_id'])) for a in all_att if a['model']) and not unmetered
    tokens = {'shown': False if not tokens_ok else True,
              'why': [f"{h}: the orchestrator starts this CLI with session records switched off ({flag}), so the harness keeps no local usage record of these calls"
                      for h, flag in (('claude_cli', '--no-session-persistence'), ('codex_cli', '--ephemeral')) if no_persist.get(h)]
              + [f'{m}: {n} of {calls[m]} calls ended without any recorded usage (aborted, restarted or failed)' for m, n in sorted(unmetered.items())],
              'perModelUnmetered': unmetered}

    # ---- flow model -> route -> outcome
    label = {'verified': 'verified', 'awaiting': 'awaiting', 'filed': 'filed', 'uncredited': 'matched upstream, uncredited', 'matched': 'matched, not filed', 'taken': 'taken by others',
             'released': 'released', 'claim': 'open claim', 'queued': 'queued'}
    flow = collections.Counter()
    for r in rows:
        if r['route'] and r['state'] in label:
            flow[('m', r['model'] or 'model not recorded', r['route'])] += 1
            flow[('o', r['route'], label[r['state']])] += 1

    # ---- facts: statements of data only
    facts = []
    if released:
        w = max(released, key=lambda r: r['attempts'] or 0)
        facts.append(f"Most attempted release: {w['name']} ({w['rva']}) with {w['attempts']} attempts on its packet.")
    nm = [r for r in released if r['nearAligned'] is not None]
    if nm:
        w = max(nm, key=lambda r: (r['nearAligned'], r['size'] or 0))
        facts.append(f"Closest released function: {w['name']} ({w['rva']}) at {w['nearAligned']}% aligned bytes, {w['size']} B.")
    if verified:
        w = max(verified, key=lambda r: r['size'] or 0)
        facts.append(f"Largest verified function: {w['name']} ({w['rva']}), {w['size']} B.")
    pk = max(range(24), key=lambda h: att_h[h])
    facts.append(f'Busiest hour of day for attempts: {pk:02d}:00 to {(pk + 1) % 24:02d}:00, {att_h[pk]} of {sum(att_h)} attempts.')
    ml = [r for r in rows if r['state'] == 'taken' and r['matchedLocal']]
    facts.append(f'{len(ml)} functions matched here ({nbytes(ml)} B) are also matched, claimed or in a pull request by someone else.')

    # ---- templates and queue
    mine = {r['rva']: r for r in rows}
    groups = [{'family': g['family'], 'version': g['version'], 'members': len(g['members']),
               'matchedUpstream': sum(1 for x in g['members'] if (up['fn'].get(x) or {}).get('s') == 'matched'),
               'yours': sum(1 for x in g['members'] if x in mine)} for g in up['groups']]
    skills = [dict(r) for r in q('select id,name,status,version,origin,trigger_count,inject_count,pass_count,fail_count from skills')]
    queued = by('queued')
    tmpl = {'groups': groups, 'skills': skills, 'ready': {**{k: v for k, v in up['ready'].items() if k != 'entries'}},
            'readyEntries': [{'rva': e[0], 'size': e[1], 'blocks': e[2], 'unlocks': e[3], 'yours': (mine.get(e[0]) or {}).get('state'),
                              'claim': up['openClaims'].get(e[0])} for e in up['ready']['entries']],
            'offered': [{'rva': a, 'size': s, 'name': (up['fn'].get(a) or {}).get('name'), 'claim': up['openClaims'].get(a),
                         'yours': (mine.get(a) or {}).get('state')} for a, s in up['targets']['offered']],
            'targets': {k: v for k, v in up['targets'].items() if k != 'offered'}, 'queued': [r['rva'] for r in queued]}

    # ---- activity
    act = []
    for e in events:
        act.append({'t': e['ts'], 'k': e['kind'], 'l': e['level'], 'm': clean(e['msg'], 300), 'run': (runs.get(e['run_id']) or {}).get('name')})
    for c in up['commits']:
        act.append({'t': int(dt.datetime.fromisoformat(c['at']).timestamp() * 1000), 'k': 'upstream.commit', 'l': 'info',
                    'm': clean(c['subject'], 300), 'run': None})
    act.sort(key=lambda a: -a['t'])

    ready_batches = [b for b in batches if b['status'] == 'branch_ready']
    cap = next((b['cap'] for b in sorted(batches, key=lambda b: -b['seq']) if b['cap']), None)
    subs_today = sum(1 for b in batches if b['submittedAt'] and b['submittedAt'] >= today)
    att24 = sum(1 for a in all_att if a['started_at'] >= now - day)
    att48 = sum(1 for a in all_att if now - 2 * day <= a['started_at'] < now - day)
    ver24 = sum(1 for t in ver_t if t >= now - day)
    ver48 = sum(1 for t in ver_t if now - 2 * day <= t < now - day)
    filed_rows = [r for r in rows if r['filedAt']]
    matched_rows = [r for r in rows if r['matchedLocal']]
    pass24 = {r['rva'] for r in matched_rows if r['passedAt'] and r['passedAt'] >= now - day}

    notes = {
        'verified': f"Status matched in data/progress.json on the fetched {REF} ({up['sha'][:10]}) and the function's report names {login} as submitter or matcher. A report counts when you filed the function or the report's first version names you; {len(rerecorded)} more now name {login} only because a merge re-recorded every function of the files it touched, and are not counted. Source: local git objects, last fetch {dt.datetime.fromtimestamp(fetched_at / 1000):%Y-%m-%d %H:%M}.",
        'uncredited': 'Filed by you and status matched upstream, but the function\'s report names no submitter or someone else. Kept apart from verified.',
        'published': f"data/contributors.json on {REF} says {(up['published'] or {}).get('verified_matches', '—')} matches / {(up['published'] or {}).get('matched_bytes', '—')} B, last changed {up['publishedAt']}; it has not been rebuilt since, so the per-function reports are used instead.",
        'filed': 'Distinct functions in the orchestrator batches that have a pull request, plus addresses in the subject lines of your commits on origin/main from other pull requests. Squash titles of the orchestrator\'s own PRs are not used: they list every function in the touched files.',
        'awaiting': 'Filed and merged (or in an open pull request), and not yet status matched on the fetched origin/main; functions the bot did not accept stay here. A function left out of a pull request because main already had a unit for it is under taken by others.',
        'status': 'No status call is made. The project tooling on this machine (sr / tools/contrib.py) has no read-only status command and no next_check_after field, so the collector contains no network code; open-PR state is what the orchestrator last stored.',
        'dailyLimit': 'No daily submission limit is recorded: the project\'s threat model lists its daily caps as removed, and no other source states one.',
        'awaitingCap': 'No cap on functions awaiting verification or merge is stated in any source.',
        'prCap': 'Functions per pull request: the cap the orchestrator stored when it regrouped batches.',
        'near': 'Near-miss score = comparator alignedBytes / target size, best failing attempt (exact = exactBytes / target size). It is not an objdiff or asm-differ percentage; none is recorded. Functions with no size-checked compare show a dash.',
        'release': 'State released: the packet is dead-lettered, quarantined or cancelled. ' + f"{sum(1 for r in released if r['claim'])} of them still have an entry in the local claims file.",
        'matched': 'matched, not filed: the Gate Keeper accepted it locally; it is in no pull request of yours. Split by the orchestrator state (staged, passed, set aside).',
        'template': 'No template or twin port is recorded in any source: the orchestrator has no such route, so there is no per-function template field. Generator families below are the upstream project\'s.',
        'flags': 'No flag or bug report is recorded in the orchestrator database, the clone\'s .local/contrib folder or your commits. Gate Keeper quarantines are verdicts, not flag reports, and are shown under releases.',
        'local': 'Accounts in use: ' + ', '.join(sorted(set(harness.values()))) + '. ' + ('Local: ' + ', '.join(local_models) if local_models else 'None is a local model.'),
        'harness': 'Harness is recorded for orchestrator attempts (account provider). For earlier work only a model name in the claim record exists, so harness is a dash.',
        'funnel': 'Cohort: functions the orchestrator picked up from sr next (its database). Claimed = at least one attempt ran (a local claim is taken first). Matched = Gate Keeper accepted. Earlier hand work is not in this funnel.',
        'bytes': 'Bytes are target function sizes, summed once per function.',
        'change': 'Pill compares the last 24 hours with the 24 hours before.',
        'modelAttr': 'A match is credited to the model of the first accepted attempt that called a model; a release to the model of the last call. Earlier work uses the model named in the claim record.',
        'hours': 'Hours are this machine\'s local time.',
        'activityFilter': 'Event data fields are not exported, and any line resembling a listing is withheld.',
    }
    verified_bytes = nbytes(verified)
    summary = {
        'generatedAt': now, 'login': login, 'fetchedAt': fetched_at, 'sha': up['sha'][:10], 'progressUpdatedAt': up['progressUpdatedAt'],
        'db': db_mode, 'states': st, 'total': len(rows),
        'kpi': {
            'verified': {'n': len(verified), 'bytes': verified_bytes, 'd24': ver24, 'p24': ver48},
            'published': up['published'] and {'n': up['published']['verified_matches'], 'bytes': up['published']['matched_bytes']},
            'filed': {'n': len(filed_rows), 'bytes': nbytes(filed_rows)},
            'awaiting': {'n': st['awaiting'] + st['filed'], 'bytes': nbytes(by('awaiting') + by('filed'))},
            'uncredited': {'n': st['uncredited'], 'bytes': nbytes(by('uncredited'))},
            'matched': {'n': len(matched_rows), 'bytes': nbytes(matched_rows), 'd24': len(pass24)},
            'unfiled': {'n': st['matched'], 'bytes': nbytes(by('matched')),
                        'held': collections.Counter(r['held'] for r in by('matched'))},
            'released': {'n': len(released), 'bytes': nbytes(released)},
            'taken': {'n': st['taken'], 'bytes': nbytes(by('taken'))},
            'attempts': {'n': len(all_att), 'd24': att24, 'p24': att48},
            'rerecorded': len(rerecorded), 'queue': len(queued), 'submissionsToday': subs_today, 'openClaims': st['claim'],
        },
        'limits': {'dailyLimit': None, 'awaitingCap': None, 'prCap': cap,
                   'readyBatch': max((b['functions'] or 0 for b in ready_batches), default=None)},
        'funnel': funnel, 'cumulative': series, 'hours': {'attempts': att_h, 'passes': pass_h}, 'grid': grid,
        'reasons': reason_table(released), 'heldReasons': reason_table(heldrows),
        'flow': [{'stage': a, 'from': x, 'to': y, 'n': n} for (a, x, y), n in sorted(flow.items())],
        'facts': facts, 'notes': notes, 'localModels': local_models,
        'upstream': {'counts': up['counts'], 'openToClaim': up['targets']['nextCandidates'], 'underClaim': up['targets']['underClaim'],
                     'snapshot': up['targets']['snapshot']},
        'batches': [{k: b[k] for k in ('seq', 'status', 'functions', 'pr', 'submittedAt', 'prState', 'mergedAt')} for b in batches
                    if b['status'] != 'superseded'],
        'runs': [{k: r[k] for k in ('name', 'status', 'started_at', 'finished_at')} for r in runs.values()],
    }
    hist = {'t': now, 'verified': len(verified), 'bytes': verified_bytes, 'awaiting': summary['kpi']['awaiting']['n'],
            'submissionsToday': subs_today, 'filed': len(filed_rows), 'queue': len(queued),
            'released': len(released), 'taken': st['taken']}
    # change pills: the newest recorded run at least 24 h old, else the oldest run that recorded the field
    past = []
    if (OUT / 'history.jsonl').exists():
        past = [json.loads(x) for x in (OUT / 'history.jsonl').read_text('utf-8').splitlines() if x.strip()]
    for key in ('awaiting', 'released', 'taken'):
        have = [p for p in past if key in p]
        old = [p for p in have if p['t'] <= now - 86_400_000]
        base = old[-1] if old else have[0] if have else None
        summary['kpi'][key]['was'] = base and {'t': base['t'], 'n': base[key]}
    with open(OUT / 'history.jsonl', 'a', encoding='utf-8') as fh:
        fh.write(json.dumps(hist) + '\n')
    lines = (OUT / 'history.jsonl').read_text('utf-8').splitlines()
    write_json(OUT / 'history.json', [json.loads(x) for x in lines[-2000:]])
    summary['historyRuns'] = len(lines)
    write_json(OUT / 'functions.json', rows)
    write_json(OUT / 'templates.json', tmpl)
    write_json(OUT / 'activity.json', act)
    write_json(OUT / 'models.json', {'rows': list(models.values()), 'tokens': tokens})
    write_json(OUT / 'summary.json', summary)
    return (f"{dt.datetime.now():%H:%M:%S} functions={len(rows)} verified={len(verified)}/{verified_bytes}B filed={len(filed_rows)} "
            f"awaiting={summary['kpi']['awaiting']['n']} released={len(released)} folders re-read={folders_read} {time.time() - started:.1f}s")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--watch', nargs='?', const=60, type=int, metavar='SECONDS')
    ap.add_argument('--db', type=Path, help='orchestrator database (default data/real.db)')
    ap.add_argument('--config', type=Path, help='orchestrator config (default config/orchestrator.json)')
    a = ap.parse_args()
    global DB, CONFIG
    DB, CONFIG = a.db or DB, a.config or CONFIG
    while True:
        try:
            print(collect(), flush=True)
        except (OSError, RuntimeError, sqlite3.Error) as e:
            print(f'collect failed: {e}', file=sys.stderr, flush=True)
            if not a.watch:
                return 1
        if not a.watch:
            return 0
        time.sleep(max(15, a.watch))


if __name__ == '__main__':
    sys.exit(main())
