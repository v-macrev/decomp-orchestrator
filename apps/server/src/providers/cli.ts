// SPDX-License-Identifier: AGPL-3.0-or-later
// CLI-profile accounts: one isolated config directory per login (CLAUDE_CONFIG_DIR / CODEX_HOME),
// so several separately-authenticated accounts run side by side. The CLI runs in an empty
// scratch directory with tools disabled — it can only return text, never touch the repo.
// The scrubbed environment strips ANTHROPIC_API_KEY / OPENAI_API_KEY so they cannot shadow the profile.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account } from '@decomp/core';
import { runBounded } from '../util/proc.js';
import { ProviderError, type CompletionRequest, type CompletionResponse, type ProviderAdapter } from './types.js';

function classifyCliFailure(text: string, timedOut: boolean, aborted: boolean): ProviderError {
  const t = text.toLowerCase();
  if (aborted) return new ProviderError('aborted', 'aborted');
  if (timedOut) return new ProviderError('timeout', 'cli timed out');
  if (/usage limit|limit reached|quota|credit balance|billing/.test(t)) return new ProviderError('quota', 'cli usage limit reached', 30 * 60_000);
  if (/rate.?limit|429|too many requests/.test(t)) return new ProviderError('rate_limited', 'cli rate limited');
  if (/overloaded|529|503/.test(t)) return new ProviderError('overloaded', 'provider overloaded');
  if (/not logged in|please run .*login|invalid api key|unauthori[sz]ed|401|403|authentication/.test(t)) return new ProviderError('auth', 'cli profile is not authenticated');
  if (/5\d\d|internal server error/.test(t)) return new ProviderError('server_error', 'provider server error');
  return new ProviderError('server_error', `cli failed: ${text.slice(0, 200)}`);
}

export class ClaudeCliAdapter implements ProviderAdapter {
  readonly kind = 'claude_cli' as const;

  async complete(account: Account, req: CompletionRequest): Promise<CompletionResponse> {
    if (account.auth.type !== 'cli_profile') throw new ProviderError('auth', 'claude_cli requires cli_profile auth');
    const dir = mkdtempSync(join(tmpdir(), 'decomp-cli-'));
    try {
      const sysFile = join(dir, 'system.txt');
      writeFileSync(sysFile, req.system);
      const args = [
        '-p', '--output-format', 'json', '--model', req.model.id,
        '--tools', '', '--strict-mcp-config', '--no-session-persistence',
        '--system-prompt-file', sysFile,
      ];
      const effort = req.effort ?? req.model.defaultEffort;
      if (effort) args.push('--effort', effort);
      if (req.jsonSchema && account.options.cliJsonSchema !== false) args.push('--json-schema', JSON.stringify(req.jsonSchema));
      const r = await runBounded(account.auth.binary ?? 'claude', args, {
        cwd: dir, stdin: req.prompt, timeoutMs: req.timeoutMs, signal: req.signal, maxOutputBytes: 8 * 1024 * 1024,
        env: { CLAUDE_CONFIG_DIR: account.auth.configDir },
      });
      let parsed: any = null;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        /* fall through */
      }
      if (r.code !== 0 || !parsed || parsed.is_error) {
        throw classifyCliFailure(`${parsed?.result ?? ''} ${r.stderr} ${r.stdout.slice(0, 2000)}`, r.timedOut, r.aborted);
      }
      const u = parsed.usage ?? {};
      const cacheRead = u.cache_read_input_tokens ?? 0;
      const cacheWrite = u.cache_creation_input_tokens ?? 0;
      const text = parsed.structured_output !== undefined ? JSON.stringify(parsed.structured_output) : String(parsed.result ?? '');
      return {
        text,
        stopReason: parsed.subtype ?? null,
        usage: { inputTokens: (u.input_tokens ?? 0) + cacheRead + cacheWrite, outputTokens: u.output_tokens ?? 0, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
        servedModel: req.model.id,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export class CodexCliAdapter implements ProviderAdapter {
  readonly kind = 'codex_cli' as const;

  async complete(account: Account, req: CompletionRequest): Promise<CompletionResponse> {
    if (account.auth.type !== 'cli_profile') throw new ProviderError('auth', 'codex_cli requires cli_profile auth');
    const dir = mkdtempSync(join(tmpdir(), 'decomp-codex-'));
    try {
      const outFile = join(dir, 'last.txt');
      const args = ['exec', '--skip-git-repo-check', '-s', 'read-only', '--json', '-m', req.model.id, '-o', outFile];
      if (req.jsonSchema) {
        const schemaFile = join(dir, 'schema.json');
        writeFileSync(schemaFile, JSON.stringify(req.jsonSchema));
        args.push('--output-schema', schemaFile);
      }
      const effort = req.effort ?? req.model.defaultEffort;
      if (effort) args.push('-c', `model_reasoning_effort=${effort === 'max' || effort === 'xhigh' ? 'high' : effort}`);
      args.push('-');
      const r = await runBounded(account.auth.binary ?? 'codex', args, {
        cwd: dir, stdin: `${req.system}\n\n${req.prompt}`, timeoutMs: req.timeoutMs, signal: req.signal, maxOutputBytes: 16 * 1024 * 1024,
        env: { CODEX_HOME: account.auth.configDir },
      });
      let text = '';
      try {
        text = readFileSync(outFile, 'utf8');
      } catch {
        /* missing on failure */
      }
      if (r.code !== 0 || !text) throw classifyCliFailure(`${r.stderr} ${r.stdout.slice(-4000)}`, r.timedOut, r.aborted);
      let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0;
      for (const line of r.stdout.split('\n')) {
        if (!line.includes('usage')) continue;
        try {
          const ev = JSON.parse(line);
          const u = ev.usage ?? ev.msg?.usage ?? ev.info?.total_token_usage;
          if (u) {
            inputTokens = u.input_tokens ?? inputTokens;
            outputTokens = u.output_tokens ?? outputTokens;
            cacheReadTokens = u.cached_input_tokens ?? cacheReadTokens;
          }
        } catch {
          /* non-JSON line */
        }
      }
      return { text, stopReason: 'completed', usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0 }, servedModel: req.model.id };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
