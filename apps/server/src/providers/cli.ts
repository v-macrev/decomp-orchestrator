// SPDX-License-Identifier: AGPL-3.0-or-later
// CLI-profile accounts: one isolated config directory per login (CLAUDE_CONFIG_DIR / CODEX_HOME),
// so several separately-authenticated accounts run side by side. The CLI runs in an empty
// scratch directory with tools disabled — it can only return text, never touch the repo.
// The scrubbed environment strips ANTHROPIC_API_KEY / OPENAI_API_KEY so they cannot shadow the profile.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Account } from '@decomp/core';
import { runBounded } from '../util/proc.js';
import { ProviderError, type CompletionRequest, type CompletionResponse, type ProviderAdapter } from './types.js';

const resolved = new Map<string, string>();

/**
 * Windows: a bare command name cannot be spawned without a shell when it is an npm `.cmd` shim
 * (Node refuses to spawn .cmd/.bat directly). Resolve it to a real executable: `<name>.exe` on PATH,
 * or the `.exe` an npm shim launches (`"%dp0%\node_modules\...\claude.exe"`). Elsewhere: unchanged.
 */
export function resolveCliBinary(name: string): string {
  if (process.platform !== 'win32' || isAbsolute(name) || /[\\/]/.test(name)) return name;
  const hit = resolved.get(name);
  if (hit) return hit;
  let out = name;
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(';').filter(Boolean)) {
    const exe = join(dir, `${name}.exe`);
    if (existsSync(exe)) {
      out = exe;
      break;
    }
    const cmd = join(dir, `${name}.cmd`);
    if (existsSync(cmd)) {
      const m = /"%dp0%\\([^"]+\.exe)"/i.exec(readFileSync(cmd, 'utf8'));
      if (m && existsSync(join(dir, m[1]!))) {
        out = join(dir, m[1]!);
        break;
      }
    }
  }
  resolved.set(name, out);
  return out;
}

/**
 * Milliseconds until "resets 3am (America/Sao_Paulo)" / "resets 11:30pm" (next occurrence of that
 * wall-clock time in that zone, or locally). Null when the message names no time.
 */
export function resetDelayMs(text: string, now = new Date()): number | null {
  const m = /resets\s+(?:[A-Za-z]{3,9}\s+\d{1,2},?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(text);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (!m[3] || m[3].toLowerCase() === 'pm') h = m[3] ? h + 12 : Number(m[1]);
  const min = Number(m[2] ?? 0);
  let cur: { h: number; m: number; s: number };
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: m[4] || undefined, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    cur = { h: get('hour'), m: get('minute'), s: get('second') };
  } catch {
    cur = { h: now.getHours(), m: now.getMinutes(), s: now.getSeconds() };
  }
  let delta = ((h * 60 + min) - (cur.h * 60 + cur.m)) * 60_000 - cur.s * 1000;
  if (delta <= 0) delta += 24 * 3_600_000;
  return delta + 60_000; // a minute of slack past the reset
}

export function classifyCliFailure(text: string, timedOut: boolean, aborted: boolean): ProviderError {
  const t = text.toLowerCase();
  if (aborted) return new ProviderError('aborted', 'aborted');
  // A missing binary is configuration, not a provider fault: do not retry it as a server error.
  if (/spawn error|enoent|is not recognized as an internal or external command/.test(t)) return new ProviderError('auth', `CLI binary not found: ${text.trim().slice(0, 160)}`);
  if (timedOut) return new ProviderError('timeout', 'cli timed out');
  // Subscription limits ("You've hit your weekly limit · resets 3am (America/Sao_Paulo)") last until
  // the stated reset — retrying every few minutes as for a 429 just burns attempts.
  if (/usage limit|limit reached|hit your [\w ]*limit|(weekly|daily|session|5-hour) limit|quota|credit balance|billing/.test(t)) {
    const wait = resetDelayMs(text) ?? 30 * 60_000;
    const when = /resets\s[^"{}\n]*?(?:\([^)]*\))?(?=["{}\n]|$)/i.exec(text)?.[0]?.trim();
    return new ProviderError('quota', `subscription limit reached${when ? ` (${when.slice(0, 80)})` : ''}`, wait);
  }
  // "The 'gpt-x' model is not supported when using Codex with a ChatGPT account": this login cannot
  // use that model at all, so retrying it (as a server error would be) only wastes attempts.
  const unsupported = /the '([^']+)' model is not supported|model[_ ]not[_ ]found|unknown model|model .{0,40}does not exist/i.exec(text);
  if (unsupported) return new ProviderError('bad_request', `model ${unsupported[1] ?? ''} is not available on this login`.replace(/\s+/g, ' '));
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
      // One fixed, empty working directory for every call: the CLI records each new cwd as a project
      // in the profile's .claude.json, so per-call temp dirs would pile up entries there.
      const cwd = join(tmpdir(), 'decomp-cli-work');
      mkdirSync(cwd, { recursive: true });
      const r = await runBounded(resolveCliBinary(account.auth.binary ?? 'claude'), args, {
        cwd, stdin: req.prompt, timeoutMs: req.timeoutMs, signal: req.signal, maxOutputBytes: 8 * 1024 * 1024,
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
      // --ignore-user-config: the profile's config.toml (sandbox mode, notify hooks, computer use,
      // MCP servers, trusted projects) is the operator's interactive setup and must not apply to
      // workers; auth still comes from CODEX_HOME. --ephemeral: no session files. read-only sandbox in
      // an empty scratch dir: the model can only answer, never write.
      const args = [
        'exec', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--ephemeral',
        '-s', 'read-only', '--color', 'never', '--json', '-m', req.model.id, '-o', outFile,
        '-c', 'approval_policy="never"',
      ];
      if (req.jsonSchema && account.options.cliJsonSchema !== false) {
        const schemaFile = join(dir, 'schema.json');
        writeFileSync(schemaFile, JSON.stringify(req.jsonSchema));
        args.push('--output-schema', schemaFile);
      }
      const effort = req.effort ?? req.model.defaultEffort;
      if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
      args.push('-');
      const cwd = join(tmpdir(), 'decomp-cli-work');
      mkdirSync(cwd, { recursive: true });
      const r = await runBounded(resolveCliBinary(account.auth.binary ?? 'codex'), args, {
        cwd, stdin: `${req.system}\n\n${req.prompt}`, timeoutMs: req.timeoutMs, signal: req.signal, maxOutputBytes: 16 * 1024 * 1024,
        env: { CODEX_HOME: account.auth.configDir },
      });
      let text = '';
      try {
        text = readFileSync(outFile, 'utf8');
      } catch {
        /* missing on failure */
      }
      if (r.code !== 0 || !text) throw classifyCliFailure(`${r.stderr} ${r.stdout.slice(-4000)}`, r.timedOut, r.aborted);
      let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
      for (const line of r.stdout.split('\n')) {
        if (!line.includes('usage')) continue;
        try {
          const ev = JSON.parse(line);
          const u = ev.usage ?? ev.msg?.usage ?? ev.info?.total_token_usage;
          if (u) {
            inputTokens = u.input_tokens ?? inputTokens;
            outputTokens = u.output_tokens ?? outputTokens;
            cacheReadTokens = u.cached_input_tokens ?? cacheReadTokens;
            cacheWriteTokens = u.cache_write_input_tokens ?? cacheWriteTokens;
          }
        } catch {
          /* non-JSON line */
        }
      }
      return { text, stopReason: 'completed', usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, servedModel: req.model.id };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
