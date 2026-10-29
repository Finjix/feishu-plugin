import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostUserDir, type DataPaths } from './paths.ts';

/*
 * Before this plugin existed the Feishu login lived inside requirement-auto's data: <user>/requirement-auto/feishu/{auth,login,login-qr}.json,
 * and the hidden browser (holding the Feishu web session, shared with CLS) in <user>/requirement-auto/cls/browser-profile. The first run of
 * this plugin for such a user moves them here, so nobody has to log in again. What is already here is never replaced, a browser that is
 * running on the old profile is left alone (moved by a later run), and a move that fails is tried again next time. Only requirement-auto's
 * own records (cls/account.json, cls/login-qr.json, batches, tmp) stay where they are.
 *
 * This can go once no user directory has requirement-auto/feishu left.
 */

const exists = (target: string) => fs.existsSync(target);

/** Whether a browser may still be using the profile: a live process holds its lock, or the port it announced still answers. */
async function inUse(profile: string): Promise<boolean> {
  try {
    const holder = JSON.parse(fs.readFileSync(`${profile}.lock`, 'utf8')) as { pid?: unknown };
    if (typeof holder.pid !== 'number') return true;
    try { process.kill(holder.pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return true; }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true; }
  let port = 0;
  try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); } catch { return false; }
  if (!Number.isInteger(port) || port <= 0) return false;
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
}

function moveFile(from: string, to: string, moved: string[]): void {
  if (!exists(from) || exists(to)) return;
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    moved.push(path.basename(to));
  } catch { /* in use or no permission: next run */ }
}

/** Moves what an earlier requirement-auto left of this user's Feishu login into this plugin's folder. Returns what was moved. */
export async function migrateLegacy(paths: DataPaths, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): Promise<string[]> {
  const old = paths.mode === 'host' ? path.join(hostUserDir(env)!, 'requirement-auto') : path.join(home, '.requirement-auto', 'default');
  if (!exists(old)) return [];
  const moved: string[] = [];
  const feishu = path.join(old, 'feishu');
  moveFile(path.join(feishu, 'auth.json'), paths.auth, moved);
  moveFile(path.join(feishu, 'login.json'), paths.login, moved);
  moveFile(path.join(feishu, 'login-qr.json'), paths.qr, moved);
  // Standalone only: the app the logins belong to. A host passes it in the environment and never reads one from a user's folder.
  if (paths.mode === 'standalone') moveFile(path.join(old, 'app.json'), path.join(paths.root, 'app.json'), moved);
  const profile = path.join(old, 'cls', 'browser-profile');
  if (exists(profile) && !exists(paths.browserProfile) && !await inUse(profile)) {
    moveFile(profile, paths.browserProfile, moved);
    if (!exists(profile)) fs.rmSync(`${profile}.lock`, { force: true }); // left by a process that has ended
  }
  // The old login folder goes once nothing of it is left but a lock nobody holds.
  try {
    const left = fs.readdirSync(feishu).filter(name => name !== 'refresh.lock');
    if (left.length === 0) fs.rmSync(feishu, { recursive: true, force: true });
  } catch { /* not there */ }
  return moved;
}
