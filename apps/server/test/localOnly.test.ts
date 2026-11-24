// SPDX-License-Identifier: AGPL-3.0-or-later
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { localOnly } from '../src/api/localOnly.js';

const send = async (headers: Record<string, string>, method: 'GET' | 'POST' = 'POST') => {
  const f = Fastify();
  localOnly(f);
  f.get('/api/x', async () => ({ ok: true }));
  f.post('/api/x', async () => ({ ok: true }));
  return (await f.inject({ method, url: '/api/x', headers: { host: '127.0.0.1:8789', ...headers } })).statusCode;
};

describe('without a token', () => {
  it('answers this machine: its own page, the dev server and command-line clients', async () => {
    const ok: Array<Record<string, string>> = [{}, { host: 'localhost:8789' }, { host: '[::1]:8789' }, { origin: 'http://localhost:8789', 'sec-fetch-site': 'same-origin' }, { origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-site' }];
    for (const h of ok) {
      expect(await send(h), JSON.stringify(h)).toBe(200);
    }
  });
  it('refuses other sites, also ones whose name resolves here', async () => {
    const bad: Array<Record<string, string>> = [{ host: 'evil.example' }, { host: 'localhost.evil.example' }, { origin: 'https://evil.example' }, { origin: 'http://localhost.evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }];
    for (const h of bad) {
      expect(await send(h), JSON.stringify(h)).toBe(403);
      expect(await send(h, 'GET'), JSON.stringify(h)).toBe(403);
    }
  });
});
