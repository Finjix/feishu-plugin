import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { main } from '../src/cli.ts';
import { migrateLegacy } from '../src/legacy.ts';
import { resolveDataPaths } from '../src/paths.ts';
import { tempDir } from './helpers/tmp.ts';

/** A user directory as requirement-auto left it before this plugin: its Feishu login and the shared browser profile. */
function oldUser(): string {
  const dir = tempDir('fs-old-');
  const old = path.join(dir, 'requirement-auto');
  fs.mkdirSync(path.join(old, 'feishu'), { recursive: true });
  fs.writeFileSync(path.join(old, 'feishu', 'auth.json'), '{"v":1,"marker":"old-login"}');
  fs.writeFileSync(path.join(old, 'feishu', 'refresh.lock'), '{}');
  fs.mkdirSync(path.join(old, 'cls', 'browser-profile', 'Default'), { recursive: true });
  fs.writeFileSync(path.join(old, 'cls', 'browser-profile', 'Default', 'Cookies'), 'cookies');
  fs.writeFileSync(path.join(old, 'cls', 'account.json'), '{"id":7}');
  fs.mkdirSync(path.join(old, 'batches', 'b1'), { recursive: true });
  return dir;
}

test('the login and the browser an earlier requirement-auto kept move here, and only those', async () => {
  const dir = oldUser();
  const env = { LARK_AGENT_USER_DIR: dir };
  const paths = resolveDataPaths(env);
  assert.deepEqual((await migrateLegacy(paths, env)).sort(), ['auth.json', 'browser-profile']);
  assert.equal(fs.readFileSync(paths.auth, 'utf8'), '{"v":1,"marker":"old-login"}');
  assert.equal(fs.readFileSync(path.join(paths.browserProfile, 'Default', 'Cookies'), 'utf8'), 'cookies');
  assert.ok(!fs.existsSync(path.join(dir, 'requirement-auto', 'feishu')), 'the old login folder is gone');
  assert.ok(!fs.existsSync(path.join(dir, 'requirement-auto', 'cls', 'browser-profile')));
  // requirement-auto's own records stay where they are.
  assert.ok(fs.existsSync(path.join(dir, 'requirement-auto', 'cls', 'account.json')));
  assert.ok(fs.existsSync(path.join(dir, 'requirement-auto', 'batches', 'b1')));
  // Once done, nothing more happens.
  assert.deepEqual(await migrateLegacy(paths, env), []);
});

test('what is already here is never replaced, and a browser still running on the old profile is left alone', async () => {
  const dir = oldUser();
  const env = { LARK_AGENT_USER_DIR: dir };
  const paths = resolveDataPaths(env);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.auth, '{"v":1,"marker":"new-login"}');
  const browser = http.createServer((_req, res) => res.end('{}'));
  await new Promise<void>(resolve => browser.listen(0, '127.0.0.1', resolve));
  try {
    const port = (browser.address() as AddressInfo).port;
    fs.writeFileSync(path.join(dir, 'requirement-auto', 'cls', 'browser-profile', 'DevToolsActivePort'), `${port}\n/devtools/browser/x`);
    assert.deepEqual(await migrateLegacy(paths, env), []);
    assert.equal(fs.readFileSync(paths.auth, 'utf8'), '{"v":1,"marker":"new-login"}');
    assert.ok(fs.existsSync(path.join(dir, 'requirement-auto', 'feishu', 'auth.json')), 'the old login stays where it is, unused');
    assert.ok(!fs.existsSync(paths.browserProfile), 'the running browser keeps its profile');
  } finally { browser.close(); }
  // The browser has gone: the next run moves the profile, with its lock left by a process that has ended.
  fs.writeFileSync(path.join(dir, 'requirement-auto', 'cls', 'browser-profile.lock'), JSON.stringify({ pid: 999_999_999, at: Date.now() }));
  assert.deepEqual(await migrateLegacy(paths, env), ['browser-profile']);
  assert.ok(!fs.existsSync(path.join(dir, 'requirement-auto', 'cls', 'browser-profile.lock')));
});

test('without a host the home folder of requirement-auto gives up its login and app to this plugin\'s', async () => {
  const home = tempDir('fs-home-');
  const old = path.join(home, '.requirement-auto', 'default');
  fs.mkdirSync(path.join(old, 'feishu'), { recursive: true });
  fs.writeFileSync(path.join(old, 'feishu', 'auth.json'), '{}');
  fs.writeFileSync(path.join(old, 'app.json'), '{"appId":"cli_a","appSecret":"s-000000"}');
  const paths = resolveDataPaths({}, home);
  assert.deepEqual((await migrateLegacy(paths, {}, home)).sort(), ['app.json', 'auth.json']);
  assert.ok(fs.existsSync(path.join(home, '.feishu-plugin', 'default', 'app.json')));
});

test('every command moves an old login first, so the user stays logged in', async () => {
  const dir = oldUser();
  const result = await main(['login', 'status'], { env: { LARK_AGENT_USER_DIR: dir, FEISHU_APP_ID: 'cli_x', FEISHU_APP_SECRET: 'secret-000000' } });
  assert.equal(result.code, 0);
  assert.ok(fs.existsSync(path.join(dir, 'feishu', 'auth.json')));
});
