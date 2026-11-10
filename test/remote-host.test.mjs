import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The remote Claude lookup runs only when FRIENDS_REMOTE_HOST names an ssh host. A stub ssh records
// every call, so the test sees whether the CLI tried to reach a host, never touching a real one.
const root = mkdtempSync(join(tmpdir(), 'friends-remote-'));
const cli = new URL('../bin/friends.mjs', import.meta.url).pathname;
const calls = join(root, 'ssh-calls');

beforeAll(() => {
  for (const dir of ['bin', 'claude/sessions', 'pi', 'codex']) mkdirSync(join(root, dir), { recursive: true });
  for (const name of ['ps', 'lsof']) writeFileSync(join(root, 'bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // answers like a host with no live Claude sessions
  writeFileSync(join(root, 'bin', 'ssh'), `#!/bin/sh\necho "$*" >> '${calls}'\ncat > /dev/null\necho '[]'\n`, { mode: 0o755 });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function resolveNobody(extraEnv) {
  rmSync(calls, { force: true });
  const env = {
    HOME: root, PATH: `${join(root, 'bin')}:/usr/bin:/bin`,
    CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), PI_XSM_DIR: join(root, 'pi'), ...extraEnv,
  };
  const child = Bun.spawn([process.execPath, cli, 'resolve', 'claude:nobody'], { env, stdout: 'pipe', stderr: 'pipe' });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { stderr, code, sshCalls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [] };
}

describe('remote Claude lookup', () => {
  test('is off when FRIENDS_REMOTE_HOST is unset: no ssh call', async () => {
    const result = await resolveNobody({});
    expect(result).toEqual({
      stderr: 'No live session matches claude:nobody. Run `friends ls` to see who is running.\n', code: 1, sshCalls: [],
    });
  });
  test('asks the named host when FRIENDS_REMOTE_HOST is set', async () => {
    const result = await resolveNobody({ FRIENDS_REMOTE_HOST: 'gpu-box' });
    expect(result).toEqual({
      stderr: 'No live session matches claude:nobody. Checked this Mac and gpu-box. Run `friends ls` to see who is running.\n',
      code: 1,
      sshCalls: ['-o BatchMode=yes -o ConnectTimeout=30 -o LogLevel=ERROR gpu-box node --input-type=module -'],
    });
  });
});
