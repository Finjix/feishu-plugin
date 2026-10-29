import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AuthStatus } from '../src/auth.ts';
import { main } from '../src/cli.ts';
import { resolveDataPaths } from '../src/paths.ts';
import { authorize, checkVerificationUrl, type DeviceOutcome, type DeviceWeb } from '../src/web-login.ts';
import { tempDir } from './helpers/tmp.ts';

const LINK = 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=abc&user_code=ABCD-1234';
const pending = (over: Partial<NonNullable<AuthStatus['pending_login']>> = {}): AuthStatus => ({
  logged_in: false, app_configured: true, storage: 'host',
  pending_login: { user_code: 'ABCD-1234', verification_uri_complete: LINK, expires_at: Date.now() + 300_000, ...over },
});

function web(outcome: DeviceOutcome): DeviceWeb & { requests: { url: string; mode: string; profileDir: string }[] } {
  const requests: { url: string; mode: string; profileDir: string }[] = [];
  return { requests, drive: async request => { requests.push(request); return outcome; } };
}

/** The paths of a scratch user, so that the QR record and the browser profile land in a temp dir. */
const scratch = () => resolveDataPaths({ LARK_AGENT_USER_DIR: tempDir('fs-web-') });

test('only the device page of this authorization is ever opened in the browser', () => {
  assert.equal(checkVerificationUrl(LINK, 'ABCD-1234'), LINK);
  for (const bad of ['http://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD-1234', 'https://evil.example/oauth/v1/device/verify?user_code=ABCD-1234',
    'https://accounts.feishu.cn.evil.example/oauth/v1/device/verify?user_code=ABCD-1234', 'https://accounts.feishu.cn/other?user_code=ABCD-1234', 'not a url']) {
    assert.throws(() => checkVerificationUrl(bad, 'ABCD-1234'), /拒绝|有效/, bad);
  }
  assert.throws(() => checkVerificationUrl(LINK, 'WXYZ-9999'), /验证码不符/);
});

test('authorize --qr: the sign-in QR is written for the user, on this user\'s profile; an existing Feishu web session is approved without a scan', async () => {
  const paths = scratch();
  const qr = web({ state: 'qr', png: Buffer.from('png-bytes') });
  const shown = await authorize(pending(), paths, qr, path.join(tempDir('fs-out-'), 'q.png'));
  assert.equal(shown.status, 'qr_ready');
  assert.deepEqual(qr.requests, [{ url: LINK, mode: 'start', profileDir: paths.browserProfile }]);
  assert.equal(fs.readFileSync(shown.qr_file, 'utf8'), 'png-bytes');
  assert.ok(fs.existsSync(paths.qr), 'the picture is recorded, to be removed once the login is done');

  const done = await authorize(pending(), paths, web({ state: 'approved' }), path.join(tempDir('fs-out-'), 'q.png'));
  assert.equal(done.status, 'approved');
  assert.match(done.message, /login poll/);
  assert.ok(!fs.existsSync(shown.qr_file) && !fs.existsSync(paths.qr), 'and the earlier picture is gone');
});

test('authorize without --qr finishes after the scan, and says so when nobody has scanned', async () => {
  const paths = scratch();
  const finish = web({ state: 'approved' });
  assert.equal((await authorize(pending(), paths, finish, undefined)).status, 'approved');
  assert.deepEqual(finish.requests.map(r => r.mode), ['finish']);
  assert.equal((await authorize(pending(), paths, web({ state: 'login_required' }), undefined)).status, 'login_required');
  assert.equal((await authorize(pending(), paths, web({ state: 'stuck', where: 'x/y' }), undefined)).status, 'stuck');
});

test('authorize needs a pending, still valid authorization and never opens the browser without one', async () => {
  const paths = scratch();
  const none = web({ state: 'approved' });
  assert.equal((await authorize({ logged_in: false, app_configured: true, storage: 'host' }, paths, none, undefined)).status, 'no_pending');
  assert.equal((await authorize(pending({ expires_at: Date.now() - 1 }), paths, none, undefined)).status, 'no_pending');
  await assert.rejects(authorize(pending({ verification_uri_complete: 'https://evil.example/x?user_code=ABCD-1234' }), paths, none, undefined), /拒绝/);
  await assert.rejects(authorize(pending(), paths, none, path.join(tempDir('fs-out-'), 'q.jpg')), /\.png/);
  assert.equal(none.requests.length, 0);

  // Through the command line: nothing pending for a fresh user, and the browser is not touched.
  const env = { LARK_AGENT_USER_DIR: tempDir('fs-web-'), FEISHU_APP_ID: 'cli_x', FEISHU_APP_SECRET: 'secret-000000' };
  const run = await main(['authorize', '--qr', path.join(tempDir('fs-out-'), 'q.png')], { env, web: none });
  assert.deepEqual([run.code, run.result!.status], [0, 'no_pending']);
  assert.equal(none.requests.length, 0);
});
