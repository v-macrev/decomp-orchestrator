# SPDX-License-Identifier: AGPL-3.0-or-later
"""What the engine has learnt about the functions of one program, kept so that it is never computed twice.

Each fact is a pure function of its inputs, so a fact computed once holds for every later search:

* `normal`: a function's admitted normal form (the IR), or the code that refused it. It depends on the image bytes of its
  extent, the validated instruction forms and the engine: its key digests exactly those.
* `callees`: the functions its normal form calls directly by address (same key).
* `sites`: what its normal form shows of each call it makes, for the callees' sake: which argument locations it sets and
  whether it reads the result (same key). Callers' evidence about a callee is gathered from these.
* `signature`: what it takes and returns, or that nothing can be told. It depends on its normal form and on its callees'
  signatures and declarations, so its key digests those keys (a Merkle key): a change anywhere below a function changes its
  key, and a change elsewhere leaves it, so invalidation follows the dependencies and nothing else.
* `alternatives`: the other readings of a signature its own code leaves open, ordered by its callers' evidence.
* `fixpoint`: the last finished round of a cycle being solved, so a cycle interrupted halfway resumes from that round.

The namespace (a digest of the engine's code and the image) is part of every row, so a store never answers for a different
engine or image. `SqliteStore` is shared by worker processes and by later campaigns, lives in the private data directory
(normal forms are derived from the image) and writes each finished unit of work in one transaction with a full sync, so an
abrupt end, even of the whole virtual machine, loses at most the unit being written. A lease says which process is computing
a unit, so that another waits for it instead of computing it again; a lease of a process that has gone is taken over.
`MemoryStore` is the same for tests.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
import zlib
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Protocol

from recon.core.inference.signature import Signature, Slot
from recon.core.ir.model import Fn

#: what `get` answers when the store has no such fact (None is a fact: "nothing can be told")
MISSING = object()
#: how long a lease holds without being renewed before another process may take the unit over
LEASE_S = 600.0


class Store(Protocol):
    def get(self, kind: str, key: str): ...

    def put(self, kind: str, key: str, value) -> bool: ...

    def transaction(self): ...

    def lease(self, kind: str, key: str) -> bool: ...

    def release(self, kind: str, key: str) -> None: ...


#: the engine's code, relative to the package, that a run's manifest names (orchestration, reporting and the command line
#: are not)
ANALYSIS_CODE = ("core", "adapters/x64_msvc", "adapters/skyrim/pack.py", "adapters/skyrim/image.py", "adapters/skyrim/verify.py", "__init__.py")


#: the modules a normal form is made by (`Pack.normal` is `recon.adapters.skyrim.normal`), and files read as they are
#: without following their imports
NORMAL_ROOTS = ("recon.adapters.skyrim.normal", "recon.adapters.x64_msvc.program", "recon.adapters.x64_msvc.unwind",
                "recon.adapters.x64_msvc.validate", "recon.adapters.x64_msvc.abi", "recon.core.ir.passes", "recon.core.ir.validate",
                "recon.adapters.skyrim.image")
NORMAL_FILES = ("adapters/x64_msvc/lift_coverage.json", "__init__.py")
#: the module that reads what a normal form shows of its calls (the functions it calls, its call sites): with the normal
#: form's code, what those facts are filed under, so that a change of it reads them again and keeps the normal forms
SITE_ROOTS = ("recon.core.inference.sites",)
#: the module every other fact is derived through (a pack's image facts, its program and the analysis they import); the
#: search, the structuring, the emitters, the compiler, the solving and the orchestration import it, not the other way
#: round, so a change to them writes other source and leaves the facts where they are
ANALYSIS_ROOTS = ("recon.adapters.skyrim.packfacts",)

_ROOT = Path(__file__).resolve().parents[1]


def import_closure(roots: tuple[str, ...]) -> set[str]:
    """The engine's source files the modules `roots` import, directly or not, read from the source (paths relative to the
    package)."""
    import ast

    out: set[str] = set()
    todo = list(roots)
    while todo:
        mod = todo.pop()
        rel = mod.split(".", 1)[1].replace(".", "/") if "." in mod else ""
        for cand in (f"{rel}.py", f"{rel}/__init__.py"):
            p = _ROOT / cand
            if p.is_file() and cand not in out:
                out.add(cand)
                parts = rel.split("/")
                pkg = parts if cand.endswith("__init__.py") else parts[:-1]
                for node in ast.walk(ast.parse(p.read_text(encoding="utf-8"))):
                    names: list[str] = []
                    if isinstance(node, ast.Import):
                        names = [a.name for a in node.names]
                    elif isinstance(node, ast.ImportFrom):
                        base = node.module or ""
                        if node.level:
                            base = ".".join(["recon", *pkg[: len(pkg) - node.level + 1], *([base] if base else [])])
                        names = [base] + [f"{base}.{a.name}" for a in node.names]
                    todo += [n for n in names if n.startswith("recon.") or n == "recon"]
                for parent in range(1, len(parts)):          # importing a module runs its packages' __init__ too
                    todo.append("recon." + ".".join(parts[:parent]))
                break
    return out


def code_digest(parts: tuple[str, ...] = ANALYSIS_CODE, files: set[str] | None = None) -> str:
    """A digest of the engine's code the facts depend on: any change to it files those facts under a new namespace.
    `parts`: directories and files relative to the package; `files`: exact files instead."""
    if files is None:
        found: set[str] = set()
        for part in parts:
            p = _ROOT / part
            if p.is_dir():
                found |= {x.relative_to(_ROOT).as_posix() for x in p.rglob("*") if x.suffix in (".py", ".json") and "__pycache__" not in x.parts}
            else:
                found.add(part)
        files = found
    h = hashlib.sha256()
    for rel in sorted(files):
        h.update(rel.encode() + b"\0" + (_ROOT / rel).read_bytes().replace(b"\r\n", b"\n") + b"\0")
    return h.hexdigest()


def normal_code_digest() -> str:
    """A digest of the code normal forms are made by: a change to the signature analysis or the search leaves it."""
    return code_digest(files=import_closure(NORMAL_ROOTS) | set(NORMAL_FILES))


def site_code_digest() -> str:
    """A digest of the code the facts read off one normal form are made by: the normal form's and the site readings'."""
    return code_digest(files=import_closure(NORMAL_ROOTS + SITE_ROOTS) | set(NORMAL_FILES))


def analysis_code_digest() -> str:
    """A digest of the code every other fact is derived with: what the pack's facts import, directly or not."""
    return code_digest(files=import_closure(ANALYSIS_ROOTS) | set(NORMAL_FILES))


#: the kinds of fact that depend only on a function's normal form (the rest depend on the whole analysis): the normal form
#: itself, and what is read off it
NORMAL_KINDS = ("normal", "callees", "sites", "callers")
SITE_KINDS = ("callees", "sites", "callers")


def namespace(*inputs: object) -> str:
    """The namespace of a program's facts: the engine's analysis code and whatever else every fact depends on (the image,
    the validated instruction forms), digested."""
    return hashlib.sha256(repr((analysis_code_digest(), *inputs)).encode()).hexdigest()


def namespaces(*inputs: object, extra: tuple = ()) -> dict[str, str]:
    """A namespace for each kind of fact: the normal kinds under the code that makes normal forms, the others under all of
    the analysis code. `extra`: what only the other kinds depend on (what is declared of imported functions), so that a
    change of it leaves the normal forms where they are."""
    normal = hashlib.sha256(repr(("normal", normal_code_digest(), *inputs)).encode()).hexdigest()
    sites = hashlib.sha256(repr(("sites", site_code_digest(), *inputs)).encode()).hexdigest()
    return {"normal": normal, **dict.fromkeys(SITE_KINDS, sites), "*": namespace(*inputs, *extra)}


# -- the facts as data ---------------------------------------------------------------------------

def _slot(x: Slot | None):
    return None if x is None else [x.kind, x.width, x.sign]


def _unslot(x) -> Slot | None:
    return None if x is None else Slot(x[0], int(x[1]), x[2])


def signature_data(s: Signature | None):
    if s is None:
        return None
    return {"params": [_slot(p) for p in s.params], "result": _slot(s.result), "evidence": [list(e) for e in s.evidence]}


def signature_of(d) -> Signature | None:
    if d is None:
        return None
    return Signature(tuple(_unslot(p) for p in d["params"]), _unslot(d["result"]), tuple(tuple(e) for e in d["evidence"]))  # type: ignore[misc]


def encode(kind: str, value) -> bytes:
    if kind == "normal":
        value = {"refused": value} if isinstance(value, str) else {"fn": value.to_data()}
    elif kind == "signature":
        value = signature_data(value)
    elif kind == "alternatives":
        value = [signature_data(s) for s in value]
    elif kind == "fixpoint":
        state, seen = value
        value = {"state": [[m, signature_data(s)] for m, s in state.items()], "seen": [[signature_data(s) for s in t] for t in seen]}
    return zlib.compress(json.dumps(value, sort_keys=True, separators=(",", ":")).encode(), 6)


def decode(kind: str, blob: bytes):
    d = json.loads(zlib.decompress(blob))
    if kind == "normal":
        return d["refused"] if "refused" in d else Fn.from_data(d["fn"])
    if kind == "signature":
        return signature_of(d)
    if kind == "alternatives":
        return tuple(signature_of(s) for s in d)
    if kind == "fixpoint":
        return ({int(m): signature_of(s) for m, s in d["state"]}, [tuple(signature_of(s) for s in t) for t in d["seen"]])
    return d


# -- stores -----------------------------------------------------------------------------------------

class MemoryStore:
    """A store in memory, encoded as the persistent one is, so that what round-trips here round-trips there."""

    def __init__(self) -> None:
        self.facts: dict[tuple[str, str], bytes] = {}
        self.leases: set[tuple[str, str]] = set()
        self._pending: list[tuple[tuple[str, str], bytes]] | None = None

    def get(self, kind: str, key: str):
        blob = self.facts.get((kind, key))
        return MISSING if blob is None else decode(kind, blob)

    def put(self, kind: str, key: str, value) -> bool:
        """Keep a fact; False when it was there already (another computation got there first)."""
        if (kind, key) in self.facts and kind != "fixpoint":
            return False
        item = ((kind, key), encode(kind, value))
        if self._pending is not None:
            self._pending.append(item)
        else:
            self.facts[item[0]] = item[1]
        return True

    def drop(self, kind: str, key: str) -> None:
        self.facts.pop((kind, key), None)

    @contextmanager
    def transaction(self) -> Iterator[None]:
        if self._pending is not None:
            yield
            return
        self._pending = []
        try:
            yield
            for k, v in self._pending:
                self.facts[k] = v
        finally:
            self._pending = None

    def lease(self, kind: str, key: str) -> bool:
        if (kind, key) in self.leases:
            return False
        self.leases.add((kind, key))
        return True

    def release(self, kind: str, key: str) -> None:
        self.leases.discard((kind, key))

    def count(self, kind: str) -> int:
        return sum(1 for k, _ in self.facts if k == kind)


def _alive(pid: int) -> bool:
    """Whether a process is running, asked without touching it (on Windows `os.kill` would end it)."""
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        k32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        k32.CloseHandle.argtypes = (wintypes.HANDLE,)
        h = k32.OpenProcess(0x1000, False, pid)             # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return ctypes.get_last_error() == 5             # access denied: it exists
        try:
            code = wintypes.DWORD()
            return bool(k32.GetExitCodeProcess(h, ctypes.byref(code))) and code.value == 259   # STILL_ACTIVE
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(pid, 0)                                      # signal 0 only checks, on POSIX
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class SqliteStore:
    """Facts on disk, shared by processes: keyed by namespace, kind and key; a fact is written once, in a transaction."""

    def __init__(self, path: str | Path, namespace: "str | dict[str, str]", owner: str | None = None) -> None:
        """`namespace`: one for every kind, or kind -> namespace with "*" for the other kinds (`namespaces`)."""
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.path = str(path)
        self.ns = namespace if isinstance(namespace, dict) else {"*": namespace}
        self.owner = owner or f"{os.getpid()}"
        self._depth = 0
        self.db = sqlite3.connect(self.path, timeout=600, isolation_level=None)
        for attempt in range(600):           # another process may be creating it: setting the journal waits for no lock
            try:
                self.db.execute("PRAGMA journal_mode=WAL")
                break
            except sqlite3.OperationalError:
                time.sleep(0.1)
        self.db.execute("PRAGMA synchronous=FULL")          # a committed unit survives the end of the machine
        with self.transaction():
            self.db.execute("CREATE TABLE IF NOT EXISTS facts (ns TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, value BLOB NOT NULL, "
                            "PRIMARY KEY (ns, kind, key)) WITHOUT ROWID")
            self.db.execute("CREATE TABLE IF NOT EXISTS leases (ns TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, owner TEXT NOT NULL, "
                            "since REAL NOT NULL, PRIMARY KEY (ns, kind, key)) WITHOUT ROWID")

    def _ns(self, kind: str) -> str:
        return self.ns.get(kind, self.ns["*"])

    def get(self, kind: str, key: str):
        row = self.db.execute("SELECT value FROM facts WHERE ns = ? AND kind = ? AND key = ?", (self._ns(kind), kind, key)).fetchone()
        return MISSING if row is None else decode(kind, row[0])

    def put(self, kind: str, key: str, value) -> bool:
        verb = "INSERT OR REPLACE" if kind == "fixpoint" else "INSERT OR IGNORE"
        with self.transaction():
            n = self.db.execute(f"{verb} INTO facts (ns, kind, key, value) VALUES (?, ?, ?, ?)", (self._ns(kind), kind, key, encode(kind, value))).rowcount
        return n == 1

    def drop(self, kind: str, key: str) -> None:
        with self.transaction():
            self.db.execute("DELETE FROM facts WHERE ns = ? AND kind = ? AND key = ?", (self._ns(kind), kind, key))

    @contextmanager
    def transaction(self) -> Iterator[None]:
        """One unit of work: everything written inside is kept together or not at all."""
        if self._depth:
            self._depth += 1
            try:
                yield
            finally:
                self._depth -= 1
            return
        self.db.execute("BEGIN IMMEDIATE")
        self._depth = 1
        try:
            yield
        except BaseException:
            self._depth = 0
            self.db.execute("ROLLBACK")
            raise
        self._depth = 0
        self.db.execute("COMMIT")

    def lease(self, kind: str, key: str) -> bool:
        """Take the unit for this process; False while another live process holds it."""
        now = time.time()
        with self.transaction():
            row = self.db.execute("SELECT owner, since FROM leases WHERE ns = ? AND kind = ? AND key = ?", (self._ns(kind), kind, key)).fetchone()
            if row is not None and row[0] != self.owner:
                pid = row[0].split(":")[0]
                if now - row[1] < LEASE_S and (not pid.isdigit() or _alive(int(pid))):
                    return False
            self.db.execute("INSERT OR REPLACE INTO leases (ns, kind, key, owner, since) VALUES (?, ?, ?, ?, ?)", (self._ns(kind), kind, key, self.owner, now))
        return True

    def release(self, kind: str, key: str) -> None:
        with self.transaction():
            self.db.execute("DELETE FROM leases WHERE ns = ? AND kind = ? AND key = ? AND owner = ?", (self._ns(kind), kind, key, self.owner))

    def keys(self, kind: str) -> set[str]:
        return {k for (k,) in self.db.execute("SELECT key FROM facts WHERE ns = ? AND kind = ?", (self._ns(kind), kind))}

    def count(self, kind: str) -> int:
        return self.db.execute("SELECT COUNT(*) FROM facts WHERE ns = ? AND kind = ?", (self._ns(kind), kind)).fetchone()[0]

    def check(self) -> str:
        return self.db.execute("PRAGMA integrity_check").fetchone()[0]

    def close(self) -> None:
        self.db.close()


def wait_for(store, kind: str, key: str, poll_s: float = 0.2):
    """The fact another process is computing: waits while its lease holds, MISSING when the lease ended without it."""
    while True:
        got = store.get(kind, key)
        if got is not MISSING:
            return got
        if store.lease(kind, key):
            return store.get(kind, key)       # finished between the look and the lease, or MISSING
        time.sleep(poll_s)


__all__ = ["ANALYSIS_CODE", "LEASE_S", "NORMAL_FILES", "NORMAL_KINDS", "NORMAL_ROOTS", "MISSING", "SITE_KINDS", "SITE_ROOTS", "ANALYSIS_ROOTS", "analysis_code_digest",
           "site_code_digest", "MemoryStore", "SqliteStore", "Store", "code_digest", "decode", "encode", "import_closure", "namespace", "namespaces", "normal_code_digest", "signature_data", "signature_of", "wait_for"]
