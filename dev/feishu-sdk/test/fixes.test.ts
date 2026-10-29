import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FeishuAuth } from '../src/auth.ts';
import { loadApp } from '../src/config.ts';
import { withLock } from '../src/fsutil.ts';
import { resolveDataPaths } from '../src/paths.ts';
import { clock } from './helpers/clock.ts';
import { MockFeishu } from './helpers/mock-feishu.ts';
import { tempDir } from './helpers/tmp.ts';

test('an app.json written with a byte order mark is read', () => {
  const dir = tempDir('fs-app-');
  fs.writeFileSync(path.join(dir, 'app.json'), '﻿{"appId":"cli_x","appSecret":"s"}');
  const app = loadApp({}, { mode: 'standalone', root: dir } as any);
  assert.equal(app.appId, 'cli_x');
});

test('a lock holder that was taken over does not remove the lock of whoever has it now', async () => {
  const dir = tempDir('fs-lock-');
  const file = path.join(dir, 'x.lock');
  await withLock(file, async () => {
    fs.rmSync(file); // taken over as stale ...
    fs.writeFileSync(file, JSON.stringify({ pid: 1, at: Date.now(), owner: 'somebody-else' })); // ... and held by another process
  });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).owner, 'somebody-else');
  fs.rmSync(file);
  await withLock(file, async () => { assert.ok(fs.existsSync(file)); });
  assert.ok(!fs.existsSync(file), 'its own lock is released');
});

async function authSetup(options: { refresh?: boolean } = {}) {
  const mock = await new MockFeishu().start();
  mock.withRefreshToken = options.refresh ?? true;
  const userDir = tempDir('fs-auth2-');
  const c = clock();
  const auth = new FeishuAuth({
    paths: resolveDataPaths({ LARK_AGENT_USER_DIR: userDir }),
    app: { appId: mock.appId, appSecret: mock.appSecret }, endpoints: mock.endpoints, now: c.now, sleep: c.sleep,
  });
  return { mock, auth, c, done: async () => { await mock.stop(); fs.rmSync(userDir, { recursive: true, force: true }); } };
}

test('a gateway error while the user is confirming does not cost them the authorization', async () => {
  const { mock, auth, done } = await authSetup();
  try {
    await auth.startLogin();
    mock.deviceScript = [{ status: 502, body: {} }, { status: 429, body: { code: 99 } }, 'issue'];
    const result = await auth.pollLogin(60_000);
    assert.equal(result.state, 'authorized');
  } finally { await done(); }
});

test('a login without a refresh token stays until its access token really ends', async () => {
  const { mock, auth, c, done } = await authSetup({ refresh: false });
  try {
    await auth.startLogin();
    mock.deviceScript = ['issue'];
    assert.equal((await auth.pollLogin(40_000)).state, 'authorized');
    const first = await auth.accessToken();
    c.state.t += (7200 - 120) * 1000; // inside the renewal margin, still valid
    assert.equal(await auth.accessToken(), first);
    assert.ok(fs.existsSync(auth.paths.auth), 'the login is not deleted early');
    c.state.t += 200 * 1000; // now it has ended
    await assert.rejects(auth.accessToken(), /已过期/);
    assert.ok(!fs.existsSync(auth.paths.auth));
  } finally { await done(); }
});
