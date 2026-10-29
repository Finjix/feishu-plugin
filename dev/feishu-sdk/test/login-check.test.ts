import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FeishuAuth } from '../src/auth.ts';
import { runBridge } from '../src/bridge.ts';
import { main } from '../src/cli.ts';
import { resolveDataPaths } from '../src/paths.ts';
import { REQUIRED_SCOPES } from '../src/config.ts';
import { clock } from './helpers/clock.ts';
import { MockFeishu } from './helpers/mock-feishu.ts';
import { tempDir } from './helpers/tmp.ts';

type Obj = Record<string, any>;

/** A user who has logged in through the device flow, and the environment a bridge command for them runs in. */
async function loggedIn(mock: MockFeishu, dir: string, extraEnv: Record<string, string> = {}) {
  const c = clock(Date.now());
  const auth = new FeishuAuth({ paths: resolveDataPaths({ LARK_AGENT_USER_DIR: dir }), app: { appId: mock.appId, appSecret: mock.appSecret }, endpoints: mock.endpoints, now: c.now, sleep: c.sleep });
  await auth.startLogin();
  mock.deviceScript = ['issue'];
  await auth.pollLogin(10_000);
  return { env: { LARK_AGENT_USER_DIR: dir, FEISHU_APP_ID: mock.appId, FEISHU_APP_SECRET: mock.appSecret, ...extraEnv }, endpoints: mock.endpoints };
}

const verify = (ctx: { env: Record<string, string>; endpoints: MockFeishu['endpoints'] }) => runBridge('auth-verify', undefined, ctx);

test('the Feishu check asks Feishu with the stored login, and a good login is reported with who it is', async () => {
  const mock = await new MockFeishu().start();
  const dir = tempDir('fs-chk-');
  try {
    mock.scope = [...REQUIRED_SCOPES, 'offline_access'].join(' ');
    const ctx = await loggedIn(mock, dir);
    const before = mock.requests('/open-apis/authen/v1/user_info').length;
    const reply = await verify(ctx);
    assert.equal(reply.ok, true);
    const data = (reply as { data: Obj }).data;
    assert.deepEqual([data.logged_in, data.open_id, data.name, data.missing_scopes], [true, 'ou_alice', '李小明', []]);
    assert.equal(mock.requests('/open-apis/authen/v1/user_info').length, before + 1, 'Feishu was asked, not the local file');
    assert.ok(!JSON.stringify(reply).includes(mock.currentAccess), 'no token in the reply');
  } finally { await mock.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a login Feishu no longer accepts is found by the check: renewed when it can be, reported when it cannot', async () => {
  const mock = await new MockFeishu().start();
  const dir = tempDir('fs-chk-');
  try {
    mock.scope = [...REQUIRED_SCOPES, 'offline_access'].join(' ');
    const ctx = await loggedIn(mock, dir);

    // The access token was forgotten but the refresh token is good: the check renews the login and passes.
    mock.revokeAccess();
    const refreshed = mock.refreshCount;
    assert.equal((await verify(ctx)).ok, true);
    assert.equal(mock.refreshCount, refreshed + 1);

    // The user withdrew the authorization: both are gone. The local file still says "logged in" until Feishu is asked.
    const status = await runBridge('auth-status', undefined, ctx);
    assert.equal((status as { data: Obj }).data.logged_in, true, 'the local record alone would have passed');
    mock.revokeAll();
    const dead = await verify(ctx);
    assert.equal(!dead.ok && dead.error.kind, 'auth_required');
    const after = await runBridge('auth-status', undefined, ctx);
    assert.equal((after as { data: Obj }).data.logged_in, false, 'and the dead login is dropped, so nothing keeps trying it');
  } finally { await mock.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the Feishu check reports no login, the wrong person, missing permissions and an unreachable Feishu as what they are', async () => {
  const mock = await new MockFeishu().start();
  const dir = tempDir('fs-chk-');
  try {
    const none = await verify({ env: { LARK_AGENT_USER_DIR: tempDir('fs-chk-none-'), FEISHU_APP_ID: mock.appId, FEISHU_APP_SECRET: mock.appSecret }, endpoints: mock.endpoints });
    assert.equal(!none.ok && none.error.kind, 'auth_required');

    mock.scope = [...REQUIRED_SCOPES.slice(0, 3), 'offline_access'].join(' ');
    const ctx = await loggedIn(mock, dir);
    const partial = await verify(ctx);
    assert.equal(partial.ok, true);
    assert.deepEqual((partial as { data: Obj }).data.missing_scopes, REQUIRED_SCOPES.slice(3));

    // The host says this process serves somebody else than the saved login belongs to.
    const other = await verify({ ...ctx, env: { ...ctx.env, LARK_AGENT_USER_OPEN_ID: 'ou_bob' } });
    assert.equal(!other.ok && other.error.kind, 'identity_mismatch');

    await mock.stop();
    const down = await verify(ctx);
    assert.equal(!down.ok && down.error.kind, 'network');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the command: login check ---------------------------------------------------------------------------------------------------

test('login check: ok with who it is, or what is wrong and what to do about it; never a token', async () => {
  const mock = await new MockFeishu().start();
  const dir = tempDir('fs-chk-');
  try {
    const nobody = await main(['login', 'check'], { env: { LARK_AGENT_USER_DIR: tempDir('fs-chk-none-'), FEISHU_APP_ID: mock.appId, FEISHU_APP_SECRET: mock.appSecret }, endpoints: mock.endpoints });
    assert.deepEqual([nobody.code, nobody.result!.status], [2, 'login_required']);
    assert.match(nobody.result!.todo[0], /login start.*authorize --qr/);

    mock.scope = [...REQUIRED_SCOPES, 'offline_access'].join(' ');
    const ctx = await loggedIn(mock, dir);
    const good = await main(['login', 'check'], ctx);
    assert.deepEqual([good.code, good.result], [0, { status: 'ok', name: '李小明' }]);
    assert.ok(!JSON.stringify(good.result).includes(mock.currentAccess));

    const other = await main(['login', 'check'], { ...ctx, env: { ...ctx.env, LARK_AGENT_USER_OPEN_ID: 'ou_bob' } });
    assert.deepEqual([other.code, other.result!.status], [2, 'identity_mismatch']);
    assert.equal(other.result!.todo, undefined, 'logging in again as the wrong person fixes nothing');

    await mock.stop();
    const down = await main(['login', 'check'], ctx);
    assert.deepEqual([down.code, down.result!.status], [2, 'unreachable']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('login check: a login without every permission is reported with what is missing', async () => {
  const mock = await new MockFeishu().start();
  const dir = tempDir('fs-chk-');
  try {
    mock.scope = [...REQUIRED_SCOPES.slice(0, 2), 'offline_access'].join(' ');
    const partial = await main(['login', 'check'], await loggedIn(mock, dir));
    assert.deepEqual([partial.code, partial.result!.status, partial.result!.missing_scopes], [2, 'scopes_missing', REQUIRED_SCOPES.slice(2)]);
  } finally { await mock.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
