// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliSearchDirs, resolveCliBinary } from '../src/providers/cli.js';

describe.runIf(process.platform === 'win32')('resolving a CLI on Windows', () => {
  it('finds an npm shim\'s executable in the APPDATA npm folder even when the server\'s PATH lacks it', () => {
    const root = mkdtempSync(join(tmpdir(), 'decomp-cli-'));
    try {
      const npm = join(root, 'npm');
      const bin = join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'claude.exe'), '');
      // The shim npm writes: "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
      const shim = ['@ECHO off', `"%dp0%${String.fromCharCode(92)}${['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'].join(String.fromCharCode(92))}"   %*`, ''].join('\r\n');
      const env = { PATH: join(root, 'elsewhere'), APPDATA: root, USERPROFILE: join(root, 'home') };
      expect(cliSearchDirs(env)).toContain(npm);
      const name = `claude-${Date.now()}`; // a fresh cache key
      writeFileSync(join(npm, `${name}.cmd`), shim);
      expect(resolveCliBinary(name, env)).toBe(join(bin, 'claude.exe'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not cache a miss, so a later install is found without a restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'decomp-cli-'));
    try {
      const env = { PATH: root, APPDATA: join(root, 'none'), USERPROFILE: join(root, 'none') };
      const name = `tool-${Date.now()}`;
      expect(resolveCliBinary(name, env)).toBe(name);
      writeFileSync(join(root, `${name}.exe`), '');
      expect(resolveCliBinary(name, env)).toBe(join(root, `${name}.exe`));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
