// SPDX-License-Identifier: AGPL-3.0-or-later
import { buildServer } from './api/server.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const cfg = loadConfig();
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
