/**
 * The boundary-claim request.
 *
 * `--bare` is the obvious way to make this cheap, and it is the reason the
 * feature did not work at all: the same help text that lists what it skips also
 * says *"Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via
 * --settings (OAuth and keychain are never read)"*. For a subscription user
 * every `--bare` request fails with `Not logged in`.
 *
 * These tests pin the flag set so that optimisation cannot be reintroduced.
 */

import { describe, expect, it } from 'vitest';
import { pingArgs } from '../src/window/ping.js';
import { toLaunchable } from '../src/claude/spawn.js';

describe('pingArgs', () => {
  const args = pingArgs('ok');

  it('never uses --bare, which cannot authenticate a subscription account', () => {
    expect(args).not.toContain('--bare');
  });

  it('still trims the context that makes a request expensive', () => {
    // No MCP servers, no skills, no session file, no default system prompt.
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--system-prompt');
  });

  it('asks for exactly one turn of plain text', () => {
    expect(args).toContain('--max-turns');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('1');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('text');
  });

  it('passes the prompt last, via -p', () => {
    expect(args[args.length - 2]).toBe('-p');
    expect(args[args.length - 1]).toBe('ok');
  });

  it('does not load any MCP config alongside --strict-mcp-config', () => {
    // --strict-mcp-config only means "nothing" when no --mcp-config is given.
    expect(args).not.toContain('--mcp-config');
  });
});

describe('toLaunchable', () => {
  it('routes a Windows batch shim through cmd.exe', () => {
    if (process.platform !== 'win32') return;
    // child_process refuses .cmd/.bat outright since the CVE-2024-27980
    // hardening, throwing EINVAL synchronously.
    const launch = toLaunchable('C:\\npm\\claude.cmd');
    expect(launch.file.toLowerCase()).toContain('cmd');
    expect(launch.prefixArgs).toEqual(['/d', '/s', '/c', 'C:\\npm\\claude.cmd']);
  });

  it('leaves a real executable alone', () => {
    const bin = process.platform === 'win32' ? 'C:\\bin\\claude.exe' : '/usr/local/bin/claude';
    const launch = toLaunchable(bin);
    expect(launch.file).toBe(bin);
    expect(launch.prefixArgs).toEqual([]);
  });
});
