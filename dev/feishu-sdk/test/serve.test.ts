import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/tmp.ts';

// The command line as another plugin runs it: a separate process with that plugin's environment (whose user is the host's).
const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'feishu.ts');
const envFor = (dir: string) => ({ ...process.env, LARK_AGENT_USER_DIR: dir, FEISHU_APP_ID: 'cli_x', FEISHU_APP_SECRET: 'secret-000000' });

test('serve answers one request per line with its id, and ends when its input does', async () => {
  const dir = tempDir('fs-serve-');
  const child = spawn(process.execPath, [ENTRY, 'serve'], { env: envFor(dir), stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  const ended = new Promise<number | null>(resolve => child.on('close', resolve));
  child.stdin.write(`${JSON.stringify({ id: 1, command: 'info' })}\n`);
  child.stdin.write(`${JSON.stringify({ id: 'b', command: 'auth-status' })}\nnot json\n`);
  child.stdin.end(`${JSON.stringify({ id: 3, command: 'rm-rf' })}\n`);
  assert.equal(await ended, 0);
  const replies = new Map(out.trim().split('\n').map(line => JSON.parse(line)).map(r => [r.id, r.reply]));
  assert.equal(replies.size, 4);
  assert.equal(replies.get(1).data.browser_profile, path.join(dir, 'feishu', 'browser-profile'));
  assert.equal(replies.get('b').data.logged_in, false);
  assert.equal(replies.get(undefined).error.kind, 'invalid_request');
  assert.equal(replies.get(3).error.kind, 'invalid_request');
  assert.ok(!out.includes('secret-000000'));
});

test('bridge runs one command with its input from stdin; human commands print one line and exit 2 when refused', () => {
  const dir = tempDir('fs-cli-');
  const bridge = spawnSync(process.execPath, [ENTRY, 'bridge', 'auth-check-scopes'], { env: envFor(dir), input: '{"required":["docx:document:readonly"]}', encoding: 'utf8' });
  assert.equal(bridge.status, 0);
  assert.deepEqual(JSON.parse(bridge.stdout), { ok: true, data: { complete: false, granted: [], missing: ['docx:document:readonly'] } });
  const bad = spawnSync(process.execPath, [ENTRY, 'login', 'nope'], { env: envFor(dir), encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stdout).status, 'blocked');
  const shared = spawnSync(process.execPath, [ENTRY, 'info'], { env: { ...process.env, LARK_AGENT_USER_OPEN_ID: 'ou_x', LARK_AGENT_USER_DIR: '' }, encoding: 'utf8' });
  assert.equal(shared.status, 2, 'a user named without a directory is refused, not served from a shared folder');
});
