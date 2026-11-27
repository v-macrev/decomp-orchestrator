# SPDX-License-Identifier: AGPL-3.0-or-later
"""A content-addressed cache of compiler runs (contract C5): a compile is answered from the cache only when every input
that can change what the compiler writes is in its key, and is then answered with what the compiler wrote.

A compile is a pure function of: the toolchain (the toolset's binaries and headers, the SDK's headers, the wrapper
scripts, the host that runs them), the environment `cl.Toolchain.run` gives it, the command line (every flag, the source's
and the object's paths, the working directory), the source's text, and the text of every project file it may include.
The key is a digest of exactly these. What may be included is found from the texts (`closure`): for each `#include` every
place the compiler may look in the order it looks (the including file's directory, then the directories of every file
that includes it, then each `/I` directory), and every candidate is keyed, the ones that exist by their content and the
ones that do not as absent, so that a file created earlier in the search order changes the key. Headers of the toolchain
and the SDK are keyed through the toolchain's digest, which covers every file of their directories. A compile whose
inputs this cannot see is never cached: a flag outside the list of flags known to write nothing but the one object
(`SAFE`), more than one source, `/I` (a system header could then find a project file), an include through a macro,
`__has_include`, `#import`, `#pragma include_alias`, `__DATE__`, `__TIME__` or `__TIMESTAMP__`, or an unreadable file.

The value is what the compiler did: its exit code, its output and the object's bytes. Two compiles of one text differ in
the COFF time stamp and nothing else (`stampless`, D12-002); an answer from the cache is the object an earlier compile of
the same inputs wrote, which equals a fresh one but for that stamp. Entries are written atomically; two processes that
miss one key both compile and both write equal values. Nothing here decides anything: the cache only saves running the
compiler again, and `fresh=True` (used before a comparator judges an object) always runs it.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path, PureWindowsPath

SCHEMA = 1


class CacheMismatch(RuntimeError):
    """A fresh compile wrote other than what the cache answered for the same key: a defect of the cache, never a result."""


ENV = "RECON_COMPILE_CACHE"

#: flags that change only how the one object is made (prefix match); anything else runs uncached
SAFE = ("/nologo", "/c", "/O1", "/O2", "/Od", "/Ox", "/Ob", "/Oi", "/Os", "/Ot", "/Oy", "/MD", "/MT", "/GS", "/EH", "/GR",
        "/fp:", "/Gy", "/GF", "/Gw", "/Zc:", "/std:", "/permissive", "/W", "/wd", "/we", "/D", "/U", "/Fo",
        "/d1reportSingleClassLayout", "/TP", "/bigobj", "/utf-8", "/arch:", "/favor:", "/volatile:", "/Zp", "/J", "/vm")
#: flags whose value is the next argument
PAIRED = ("/D", "/U", "/I", "/FI")
INCLUDE = re.compile(rb'^[ \t]*#[ \t]*include[ \t]*(?:"([^"\r\n]+)"|<([^>\r\n]+)>|(\S))', re.M)
TOXIC = (rb"__has_include", rb"__DATE__", rb"__TIME__", rb"__TIMESTAMP__", rb"include_alias")
IMPORT = re.compile(rb"^[ \t]*#[ \t]*import\b", re.M)


def stampless(obj: bytes) -> bytes:
    """A COFF object with its time stamp (bytes 4 to 8 of the file header) cleared: what two compiles of one text share."""
    return obj[:4] + b"\0\0\0\0" + obj[8:] if len(obj) >= 20 else obj


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


# -------------------------------------------------------------------------------------------- the toolchain's digest

_IDENTITY: dict[tuple[str, str], str] = {}
_LOCK = threading.Lock()


def _tree(h, base: Path) -> None:
    """Every file under `base`, by path relative to it and content, in a fixed order."""
    if not base.exists():
        h.update(b"absent\0" + str(base).encode() + b"\0")
        return
    files = sorted(p for p in base.rglob("*") if p.is_file()) if base.is_dir() else [base]
    h.update(f"tree\0{len(files)}\0".encode())
    for p in files:
        rel = p.relative_to(base).as_posix() if base.is_dir() else p.name
        h.update(rel.encode() + b"\0" + hashlib.sha256(p.read_bytes()).digest())


def identity(tool) -> str:
    """The digest of everything of the toolchain a compile can read or run: the toolset's binaries and headers, the SDK
    headers the wrappers name, the wrapper scripts and the host's `wine` version. Computed once per process (the
    toolchain is installed once and not changed while a run uses it)."""
    k = (str(tool.root), str(tool.wrappers))
    with _LOCK:
        if k in _IDENTITY:
            return _IDENTITY[k]
    h = hashlib.sha256(b"toolchain\0")
    for base in [tool.root / "bin/Hostx64/x64", tool.root / "atlmfc/include", *tool.include_dirs(), *(_sdk_extra(tool))]:
        h.update(str(base).encode() + b"\0")
        _tree(h, base)
    if tool.wrappers is not None:
        h.update(b"wrappers\0")
        _tree(h, tool.wrappers)
        try:
            v = subprocess.run(["wine", "--version"], capture_output=True, timeout=60).stdout
        except (OSError, subprocess.TimeoutExpired):
            v = b"unknown"
        h.update(b"wine\0" + v)
    d = h.hexdigest()
    with _LOCK:
        _IDENTITY[k] = d
    return d


def _sdk_extra(tool) -> list[Path]:
    """Header directories the wrappers add beyond `include_dirs` (the kernel-mode one)."""
    return [p.parent / "km" for p in tool.include_dirs()[-1:] if (p.parent / "km").is_dir()]


# -------------------------------------------------------------------------------------------- what a compile reads

@dataclass
class Command:
    flags: list[str]
    source: Path            # absolute
    obj: Path               # absolute
    includes: list[Path]    # the /I directories, absolute


def parse(args: list[str], cwd: Path) -> Command | str:
    """The one source and object of a command line, or why it is not cached."""
    flags, sources, includes = [], [], []
    obj: Path | None = None
    k = 0
    while k < len(args):
        a = args[k]
        if a[:1] in "/-" and len(a) > 1:
            f = "/" + a[1:]
            if f in PAIRED:
                if k + 1 >= len(args):
                    return "flag-without-value"
                k += 1
                f = f + args[k]
            if f.startswith("/I") or f.startswith("/FI"):
                return "include-directory"
            if not f.startswith(SAFE):
                return "flag:" + f.split(":")[0][:24]
            if f.startswith("/Fo"):
                v = f[3:]
                if not v or v.endswith(("/", "\\")):
                    return "object-directory"
                obj = Path(v) if Path(v).is_absolute() else cwd / v
            flags.append(f)
        else:
            sources.append(a)
        k += 1
    if len(sources) != 1:
        return "sources:%d" % len(sources)
    src = Path(sources[0]) if Path(sources[0]).is_absolute() else cwd / sources[0]
    if obj is None:
        obj = cwd / (PureWindowsPath(sources[0]).stem + ".obj")
    elif obj.is_dir():
        return "object-directory"
    return Command(flags, src, obj, includes)


def closure(source: Path, text: bytes, includes: list[Path]) -> dict[str, str] | str:
    """Every project file the source may include, directly or not, with its digest ("absent" for a place the compiler would
    look that holds nothing), or why the includes cannot be followed."""
    # A quoted include is looked for in the including file's directory and in the directories of the files that include it,
    # which depend on the path it was reached by. Every file's quoted includes are looked for in the directories of all
    # files of the closure instead (a superset of any one path's), repeated until no file is added.
    files: dict[Path, bytes] = {source: text}
    names: set[tuple[str, bool]] = set()
    out: dict[str, str] = {}
    done: set[Path] = set()
    while True:
        for path in [p for p in files if p not in done]:
            done.add(path)
            body = files[path]
            if any(t in body for t in TOXIC) or IMPORT.search(body):
                return "construct"
            for m in INCLUDE.finditer(body):
                if m.group(3) is not None:
                    return "macro-include"
                names.add(((m.group(1) or m.group(2)).decode("utf-8", "replace").replace("\\", "/"), m.group(1) is not None))
        dirs = sorted({p.parent for p in files})
        added = False
        for name, quoted in sorted(names):
            bases = [Path("/")] if Path(name).is_absolute() else (dirs if quoted else []) + includes
            for base in bases:
                q = Path(os.path.normpath(base / name))
                if str(q) in out:
                    continue
                if q.is_file():
                    try:
                        b = q.read_bytes()
                    except OSError:
                        return "unreadable"
                    out[str(q)] = _sha(b)
                    files[q] = b
                    added = True
                else:
                    out[str(q)] = "absent"
        if not added:
            break
    return dict(sorted(out.items()))


# -------------------------------------------------------------------------------------------- the store

@dataclass
class Stats:
    hits: int = 0
    misses: int = 0
    fresh: int = 0
    uncached: dict[str, int] = field(default_factory=dict)
    saved_s: float = 0.0          # compile time the hits did not spend (as measured when each was stored)
    key_s: float = 0.0            # time spent making keys

    def as_dict(self) -> dict:
        return {"hits": self.hits, "misses": self.misses, "fresh": self.fresh, "uncached": dict(sorted(self.uncached.items())),
                "saved_s": round(self.saved_s, 1), "key_s": round(self.key_s, 1)}


class Cache:
    """Entries as files under `root`: `<key[:2]>/<key>.json` (exit code, output, the compile's time) and `.obj`."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.stats = Stats()

    def _paths(self, key: str) -> tuple[Path, Path]:
        d = self.root / key[:2]
        return d / f"{key}.json", d / f"{key}.obj"

    def get(self, key: str) -> tuple[int, str, bytes | None, float] | None:
        meta, objp = self._paths(key)
        try:
            m = json.loads(meta.read_text(encoding="utf-8"))
            if m.get("schema") != SCHEMA:
                return None
            obj = objp.read_bytes() if m["obj"] else None
            if obj is not None and _sha(obj) != m["obj"]:
                return None                         # a torn or damaged entry is no entry
            return int(m["code"]), str(m["out"]), obj, float(m.get("s", 0.0))
        except (OSError, ValueError, KeyError):
            return None

    def put(self, key: str, code: int, out: str, obj: bytes | None, seconds: float) -> None:
        meta, objp = self._paths(key)
        meta.parent.mkdir(parents=True, exist_ok=True)
        tag = f".{os.getpid()}.{threading.get_ident()}.tmp"
        if obj is not None:
            t = objp.with_name(objp.name + tag)
            t.write_bytes(obj)
            os.replace(t, objp)
        t = meta.with_name(meta.name + tag)
        t.write_text(json.dumps({"schema": SCHEMA, "code": code, "out": out, "obj": _sha(obj) if obj is not None else None,
                                 "s": round(seconds, 3)}, sort_keys=True), encoding="utf-8")
        os.replace(t, meta)


_CACHES: dict[str, Cache] = {}


def active() -> Cache | None:
    """The cache this process uses: the directory `RECON_COMPILE_CACHE` names (inherited by worker processes), or none."""
    d = os.environ.get(ENV)
    if not d:
        return None
    if d not in _CACHES:
        _CACHES[d] = Cache(d)
    return _CACHES[d]


def key(tool, name: str, args: list[str], cwd: Path, env: dict[str, str]) -> tuple[str, Command] | str:
    """The key of one compile, with its command, or why it is not cached."""
    if name != "cl":
        return "tool:" + name
    cmd = parse(args, Path(cwd).resolve())
    if isinstance(cmd, str):
        return cmd
    try:
        text = cmd.source.read_bytes()
    except OSError:
        return "unreadable"
    inc = closure(cmd.source, text, cmd.includes)
    if isinstance(inc, str):
        return inc
    k = _sha(json.dumps({"schema": SCHEMA, "toolchain": identity(tool), "env": dict(sorted(env.items())), "args": list(args),
                         "cwd": str(Path(cwd).resolve()), "source": [str(cmd.source), _sha(text)], "obj": str(cmd.obj),
                         "includes": inc}, sort_keys=True).encode())
    return k, cmd


def run(tool, name: str, args: list[str], cwd: Path, env: dict[str, str], execute, fresh: bool = False) -> tuple[int, str]:
    """`execute()` (the real compile: exit code and output) unless the cache holds this compile; the object is left where
    the command line says, as the compiler would leave it."""
    _LAST.how = "uncached"
    cache = active()
    if cache is None:
        return execute()
    t0 = time.monotonic()
    got = key(tool, name, args, cwd, env)
    cache.stats.key_s += time.monotonic() - t0
    if isinstance(got, str):
        cache.stats.uncached[got] = cache.stats.uncached.get(got, 0) + 1
        return execute()
    k, cmd = got
    if not fresh:
        hit = cache.get(k)
        if hit is not None:
            code, out, obj, s = hit
            if obj is not None:                     # the compiler writes an object only when it succeeds
                cmd.obj.parent.mkdir(parents=True, exist_ok=True)
                tmp = cmd.obj.with_name(cmd.obj.name + f".{os.getpid()}.tmp")
                tmp.write_bytes(obj)
                os.replace(tmp, cmd.obj)
            cache.stats.hits += 1
            cache.stats.saved_s += s
            _LAST.how = "hit"
            return code, out
    t0 = time.monotonic()
    code, out = execute()
    s = time.monotonic() - t0
    obj = cmd.obj.read_bytes() if code == 0 and cmd.obj.is_file() else None
    if fresh:
        cache.stats.fresh += 1
    else:
        cache.stats.misses += 1
    cache.put(k, code, out, obj, s)
    _LAST.how = "fresh" if fresh else "miss"
    return code, out


#: how the last compile of this thread was answered: "hit", "miss", "fresh" or "uncached"
_LAST = threading.local()


def last() -> str:
    return getattr(_LAST, "how", "uncached")


__all__ = ["Cache", "CacheMismatch", "ENV", "SAFE", "SCHEMA", "Stats", "active", "closure", "identity", "held", "key", "last", "parse", "run", "stampless"]


@contextmanager
def held(path: str | Path):
    """An exclusive lock on the file `path` across processes, for as long as the block runs (what shares temporary files
    under one name, as the compiles of one unit do, holds it while it writes, compiles and reads them)."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a+b") as f:
        if os.name == "nt":
            import msvcrt

            while True:
                try:
                    f.seek(0)
                    msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)
                    break
                except OSError:
                    continue
            try:
                yield
            finally:
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(f, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)
