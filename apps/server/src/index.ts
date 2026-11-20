// SPDX-License-Identifier: AGPL-3.0-or-later
import { buildServer } from './api/server.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const cfg = loadConfig();
// The API can start runs that spend money and write to the target checkout: never serve it beyond
// this machine without a token unless the operator says so explicitly.
const loopback = /^(127\.\d+\.\d+\.\d+|::1|\[::1\]|localhost)$/i.test(cfg.host);
if (!loopback && !process.env.ORCH_API_TOKEN) {
  if (process.env.ORCH_ALLOW_UNAUTHENTICATED !== '1') {
    console.error(`refusing to bind ${cfg.host} without ORCH_API_TOKEN: anyone who can reach it could start runs and read listings. Set ORCH_API_TOKEN, bind 127.0.0.1, or set ORCH_ALLOW_UNAUTHENTICATED=1 if the network is trusted.`);
    process.exit(1);
  }
  console.warn(`WARNING: serving the API on ${cfg.host} without authentication (ORCH_ALLOW_UNAUTHENTICATED=1)`);
}
const app = await createApp(cfg);
const server = await buildServer(app);
await server.listen({ host: cfg.host, port: cfg.port });
console.log(`decomp-orchestrator (${cfg.mode} mode, repo=${app.repo.name}, ${app.repo.slotCount} slots) on http://${cfg.host}:${cfg.port}`);
await app.engine.resumeOnBoot();

let closing = false;
const shutdown = async (sig: string) => {
  if (closing) return;
  closing = true;
  console.log(`\n${sig}: shutting down; in-flight attempts will be recovered on next start`);
  await server.close().catch(() => undefined);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
