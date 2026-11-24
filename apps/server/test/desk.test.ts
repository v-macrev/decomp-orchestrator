// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServerConfig } from '../src/config.js';
import { deskEnabled, registerDeskRoutes, startDeskCollector } from '../src/desk.js';

const repoCfg = ServerConfig.parse({ mode: 'repo', repo: { path: '/x', localDir: '/x/.local' } });
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'desk-'));
  mkdirSync(join(dir, 'detail'));
  mkdirSync(join(dir, 'cache'));
  writeFileSync(join(dir, 'summary.json'), '{"ok":1}');
  writeFileSync(join(dir, 'detail', '0xabc.json'), '{"rva":"0xabc"}');
  writeFileSync(join(dir, 'cache', 'x.json'), '{"secret":1}');
  writeFileSync(join(dir, 'history.jsonl'), '{}');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const server = (cfg = repoCfg) => {
  const f = Fastify();
  registerDeskRoutes(f, cfg, dir);
  return f;
};
const get = (url: string, cfg = repoCfg, host = '127.0.0.1:8789') => server(cfg).inject({ method: 'GET', url, headers: { host } });

describe('desk routes', () => {
  it('serves the listed files, uncached', async () => {
    const r = await get('/api/desk/summary');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: 1 });
    expect(r.headers['cache-control']).toBe('no-store');
    expect((await get('/api/desk/detail/0xabc')).json()).toEqual({ rva: '0xabc' });
  });
  it('refuses the cache folder, other names, traversal and writes', async () => {
    for (const url of ['/api/desk/cache', '/api/desk/cache/x', '/api/desk/history.jsonl', '/api/desk/..%2F..%2Fpackage', '/api/desk/detail/..%2Fsummary', '/api/desk/detail/0xABC']) {
      expect((await get(url)).statusCode, url).toBe(404);
    }
    for (const method of ['POST', 'PUT', 'DELETE'] as const) expect((await server().inject({ method, url: '/api/desk/summary', headers: { host: 'localhost' } })).statusCode).toBe(404);
  });
  it('refuses another host name', async () => {
    expect((await get('/api/desk/summary', repoCfg, 'evil.example')).statusCode).toBe(403);
    expect((await get('/api/desk/summary', repoCfg, 'localhost:8789')).statusCode).toBe(200);
  });
  it('says when a file was not collected yet', async () => {
    expect((await get('/api/desk/models')).json()).toEqual({ error: 'not collected yet' });
  });
  it('is off in simulation and starts no collector there', async () => {
    const sim = ServerConfig.parse({});
    expect(deskEnabled(sim)).toBe(false);
    expect((await get('/api/desk/summary', sim)).statusCode).toBe(404);
    startDeskCollector(sim, 'none')();
  });
  it('reports a collector that cannot start, and keeps going', async () => {
    const msgs: string[] = [];
    const cfg = ServerConfig.parse({ ...repoCfg, desk: { python: ['no-such-python-binary'] } });
    const stop = startDeskCollector(cfg, 'none', (m) => msgs.push(m));
    await expect.poll(() => msgs.length, { timeout: 5000 }).toBe(1);
    stop();
    expect(msgs[0]).toContain('cannot start no-such-python-binary');
  });
});
