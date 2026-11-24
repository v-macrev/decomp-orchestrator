// SPDX-License-Identifier: AGPL-3.0-or-later
// The desk views (Overview, Solved, Near misses, ...): runs the read-only collector on a timer and
// serves the JSON files it writes below data/desk. Nothing here changes a run, a claim or a PR.
import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerConfig } from './config.js';
import { fromRoot } from './config.js';

const NAME = /^(?:summary|functions|templates|models|activity|history)$/;
const RVA = /^0x[0-9a-f]{1,16}$/;
const LOCAL_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;
/** What a child process needs to start; no API key or token of this process reaches the collector. */
const ENV_KEYS = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'ProgramFiles', 'LANG', 'WSL_UTF8'];

/** The desk needs the real checkout's records, so a simulation has none. */
export const deskEnabled = (cfg: ServerConfig) => cfg.mode === 'repo' && cfg.desk.enabled && cfg.dbPath !== ':memory:';

/** Collects once now and then every `intervalSec`, one run at a time. Returns a stop function. */
export function startDeskCollector(cfg: ServerConfig, configPath: string, log: (msg: string) => void = console.warn): () => void {
  if (!deskEnabled(cfg)) return () => undefined;
  const [cmd, ...args] = cfg.desk.python;
  const env = Object.fromEntries(ENV_KEYS.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])));
  let child: ChildProcess | null = null;
  let lastError = '';
  const report = (msg: string) => {
    if (msg === lastError) return; // a repeating failure is said once
    lastError = msg;
    if (msg) log(`desk collector: ${msg}`);
  };
  const run = () => {
    if (child) return;
    let err = '';
    const c = spawn(cmd!, [...args, fromRoot('tools/desk/collect.py'), '--db', fromRoot(cfg.dbPath), '--config', configPath], {
      cwd: fromRoot('.'), env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    child = c;
    c.stderr?.on('data', (b: Buffer) => { err = (err + b.toString()).slice(-400); });
    let started = true;
    c.on('error', (e) => { started = false; child = null; report(`cannot start ${cmd}: ${e.message}`); });
    c.on('close', (code) => { child = null; if (started) report(code ? `exited with ${code}: ${err.trim()}` : ''); }); // a failed spawn closes too
  };
  run();
  const timer = setInterval(run, cfg.desk.intervalSec * 1000);
  return () => {
    clearInterval(timer);
    child?.kill();
  };
}

/** GET-only, names from a fixed list, never the collector's cache folder. Under /api/, so the token hook covers it. */
export function registerDeskRoutes(f: FastifyInstance, cfg: ServerConfig, dir = fromRoot('data/desk')) {
  const send = (req: FastifyRequest, reply: FastifyReply, file: string) => {
    if (!LOCAL_HOST.test(req.headers.host ?? '')) return reply.code(403).send({ error: 'the desk is served on this machine only' });
    if (!deskEnabled(cfg)) return reply.code(404).send({ error: 'the desk needs repo mode' });
    if (!existsSync(file)) return reply.code(404).send({ error: 'not collected yet' });
    return reply.header('cache-control', 'no-store').type('application/json; charset=utf-8').send(createReadStream(file));
  };
  f.get('/api/desk/:name', async (req: FastifyRequest<{ Params: { name: string } }>, reply) =>
    (NAME.test(req.params.name) ? send(req, reply, join(dir, `${req.params.name}.json`)) : reply.code(404).send({ error: 'not found' })));
  f.get('/api/desk/detail/:rva', async (req: FastifyRequest<{ Params: { rva: string } }>, reply) =>
    (RVA.test(req.params.rva) ? send(req, reply, join(dir, 'detail', `${req.params.rva}.json`)) : reply.code(404).send({ error: 'not found' })));
}
