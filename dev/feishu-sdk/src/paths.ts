import os from 'node:os';
import path from 'node:path';
import { BridgeError } from './errors.ts';

/**
 * Where one user's Feishu data lives: the login, a device authorization waiting to be confirmed, and the hidden browser that holds
 * the user's Feishu web session (other plugins use it too, see `browserProfile`). The directory is decided by the host (lark-agent)
 * for the process it starts, never by a tool argument or by the model: whoever is served by this process can only reach this one
 * directory. Plugins that call this one inherit the same environment, so they reach the same user's data.
 */
export interface DataPaths {
  /** host: LARK_AGENT_USER_DIR was given; standalone: the home folder fallback */
  mode: 'host' | 'standalone';
  root: string;
  auth: string;
  login: string;
  lock: string;
  /** The record of a sign-in QR picture that is waiting to be scanned (see qr.ts). */
  qr: string;
  /**
   * The profile of this user's hidden browser. Signing in to Feishu there (the QR of `authorize --qr`) gives it a Feishu web session,
   * which is also what the company's single sign-on asks for: a plugin whose site signs in through Feishu (requirement-auto's CLS)
   * opens its pages on this profile, so one scan covers both.
   */
  browserProfile: string;
}

/** The plugin's folder in a user directory the host hands out (`user/<name>/feishu`), and the home folder fallback without a host. */
export const PLUGIN_FOLDER = 'feishu';
export const STANDALONE_FOLDER = '.feishu-plugin';

function absolute(name: string, value: string): string {
  if (value.includes('\0') || !path.isAbsolute(value)) throw new BridgeError('config', `${name} 必须是绝对路径`);
  const resolved = path.resolve(value);
  if (path.dirname(resolved) === resolved) throw new BridgeError('config', `${name} 不能是磁盘根目录`);
  return resolved;
}

function layout(mode: DataPaths['mode'], root: string): DataPaths {
  return {
    mode, root, auth: path.join(root, 'auth.json'), login: path.join(root, 'login.json'), lock: path.join(root, 'refresh.lock'),
    qr: path.join(root, 'login-qr.json'), browserProfile: path.join(root, 'browser-profile'),
  };
}

export const USER_DIR_ENV = 'LARK_AGENT_USER_DIR';
export const OPEN_ID_ENV = 'LARK_AGENT_USER_OPEN_ID';

/** The user directory the host gave, if it gave one (`user/<name>`, not its workspace). */
export function hostUserDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const userDir = env[USER_DIR_ENV]?.trim();
  return userDir ? absolute(USER_DIR_ENV, userDir) : undefined;
}

export function resolveDataPaths(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): DataPaths {
  const userDir = hostUserDir(env);
  if (userDir) return layout('host', path.join(userDir, PLUGIN_FOLDER));
  // A host that names the user but not the directory has forgotten the directory: falling back to a folder shared by everybody
  // would let that user's login be reached by the next one.
  if (env[OPEN_ID_ENV]?.trim()) throw new BridgeError('config', `${OPEN_ID_ENV} 已设置但没有 ${USER_DIR_ENV}：拒绝回落到共享目录`);
  return layout('standalone', path.join(home, STANDALONE_FOLDER, 'default'));
}

/** The Feishu Open ID the host says this process serves, if it said so. Logging in as anybody else is refused. */
export function expectedOpenId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[OPEN_ID_ENV]?.trim();
  if (!value) return undefined;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new BridgeError('config', `${OPEN_ID_ENV} 格式无效`);
  return value;
}
