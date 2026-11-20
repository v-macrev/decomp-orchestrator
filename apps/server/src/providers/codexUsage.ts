// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import type { Account } from '@decomp/core';
import { z } from 'zod';
import { scrubbedEnv } from '../util/proc.js';
import { resolveCliBinary } from './cli.js';

const Window = z.object({
  usedPercent: z.number(),
  windowDurationMins: z.number().nullish(),
  resetsAt: z.number().nullish(),
});
const Bucket = z.object({
  limitId: z.string().nullish(),
  limitName: z.string().nullish(),
  planType: z.string().nullish(),
  primary: Window.nullish(),
  secondary: Window.nullish(),
});
const Limits = z.object({
  rateLimits: Bucket,
  rateLimitsByLimitId: z.record(z.string(), Bucket).nullish(),
});

/** Read the quota reported for the same Codex login used by the worker. */
export async function readCodexUsage(account: Account) {
  if (account.provider !== 'codex_cli' || account.auth.type !== 'cli_profile') {
    throw new Error('Subscription usage requires a Codex CLI profile');
  }
  const child = spawn(resolveCliBinary(account.auth.binary ?? 'codex'), ['app-server', '--listen', 'stdio://'], {
    cwd: tmpdir(),
    env: scrubbedEnv({ CODEX_HOME: account.auth.configDir }),
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  const result = await new Promise<z.infer<typeof Limits>>((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => finish(new Error('Codex usage request timed out')), 15_000);
    function finish(value: Error | z.infer<typeof Limits>) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      if (value instanceof Error) reject(value);
      else resolve(value);
    }
    const send = (message: object) => child.stdin.write(JSON.stringify(message) + '\n');
    child.on('error', () => finish(new Error('Could not start Codex CLI')));
    child.stdin.on('error', () => finish(new Error('Could not communicate with Codex CLI')));
    child.on('close', () => finish(new Error('Codex CLI closed before returning usage')));
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message.method || (message.id !== 1 && message.id !== 2)) return;
        if (message.error) return finish(new Error('Codex could not read subscription usage. Check the profile login and CLI version.'));
        if (message.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else {
          finish(Limits.parse(message.result));
        }
      } catch {
        finish(new Error('Codex CLI returned an invalid usage response'));
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'decomp-orchestrator', version: '0.1.0' } } });
  });
  const buckets = new Map([[result.rateLimits.limitId ?? 'codex', result.rateLimits]]);
  for (const [id, bucket] of Object.entries(result.rateLimitsByLimitId ?? {})) buckets.set(id, bucket);
  return [...buckets].map(([id, bucket]) => ({
    id,
    label: bucket.limitName || id,
    plan: bucket.planType ?? result.rateLimits.planType ?? null,
    windows: [bucket.primary, bucket.secondary].flatMap((window) => window ? [window] : []),
  }));
}
