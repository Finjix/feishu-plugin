import path from 'node:path';
import { findBrowser, openBrowser } from './browser.ts';
import { approveConsent } from './consent.ts';
import { Blocked, need } from './errors.ts';
import type { AuthStatus } from './auth.ts';
import { clearQr, reapStaleQr, writeQr } from './qr.ts';
import type { DataPaths } from './paths.ts';

/*
 * The Feishu login by device authorization, completed in the hidden browser instead of in the user's own browser.
 *
 * The device flow (login start / login poll) needs somebody to open a link on accounts.feishu.cn, be logged in to Feishu there, and
 * press 【授权】. The user's browser is not the only place that can do that: this user's hidden browser can too. If it is not logged in to
 * Feishu, the link lands on Feishu's QR sign-in page, which is shown to the user as a picture to scan with their phone. That one scan
 * gives the browser a Feishu web session, which also covers the company's single sign-on of sites other plugins open on the same
 * profile (requirement-auto's CLS), so the user scans once for all of them.
 *
 * The user has authorised this: the page is only ever reached through the verification link of this user's own pending device
 * authorization, 【授权】 is the only thing pressed (never 【拒绝】), once per page, and who ends up logged in is still decided by the
 * login itself (the account has to be the user this process serves).
 */

type Result = Record<string, any>;

const FEISHU_HOST = /^accounts\.(feishu\.cn|larksuite\.com)$/;
const isLoginPage = (url: URL): boolean => FEISHU_HOST.test(url.hostname) && url.pathname.includes('login');
const isConsentPage = (url: URL): boolean => FEISHU_HOST.test(url.hostname) && url.pathname.startsWith('/open-apis/authen/v1/authorize');
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The verification link of a pending device authorization, and nothing else: Feishu's accounts host, its device page, this request's code. */
export function checkVerificationUrl(raw: string, userCode: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Blocked('飞书授权链接不是有效的地址'); }
  need(url.protocol === 'https:' && FEISHU_HOST.test(url.hostname) && url.pathname.startsWith('/oauth/v1/device/verify'), '飞书授权链接不是飞书账号服务的设备授权页，拒绝打开');
  need(!userCode || raw.includes(userCode), '飞书授权链接与当前的验证码不符，拒绝打开');
  return url.toString();
}

export type DeviceOutcome =
  /** 【授权】 was pressed and the page moved on. */
  | { state: 'approved' }
  /** The browser is on the Feishu sign-in page, left running, and this is a picture of its code. */
  | { state: 'qr'; png: Buffer }
  /** Still on the sign-in page: nobody has scanned (or the code has expired). */
  | { state: 'login_required' }
  /** Neither a sign-in page nor an authorisation page, or the button did nothing. `where` is host and path only. */
  | { state: 'stuck'; where: string };

export interface DeviceOptions {
  profileDir: string;
  url: string;
  /** start: open the link in a fresh page and, if it is the sign-in page, take its picture. finish: watch the page that is waiting. */
  mode: 'start' | 'finish';
  waitMs: number;
  settleMs?: number;
  /** How long to wait after pressing the button before leaving the page. */
  afterClickMs?: number;
  exe?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

export async function driveDeviceAuthorization(options: DeviceOptions): Promise<DeviceOutcome> {
  const exe = options.exe ?? findBrowser(options.env);
  if (!exe) throw new Blocked('没有找到 Chrome 或 Edge：请安装其一，或用环境变量 FEISHU_BROWSER 指定浏览器的绝对路径');
  const start = options.mode === 'start';
  const browser = await openBrowser({ exe, profileDir: options.profileDir, detach: start, ...(options.env ? { env: options.env } : {}) });
  let keepRunning = false;
  try {
    const { cdp } = browser;
    const { targetInfos } = await cdp.send<{ targetInfos: { type: string; targetId: string; url: string }[] }>('Target.getTargets');
    const pages = targetInfos.filter(t => t.type === 'page');
    const hostOf = (url: string) => { try { return new URL(url).hostname; } catch { return ''; } };
    const chosen = (!start ? pages.find(p => FEISHU_HOST.test(hostOf(p.url))) : undefined) ?? pages[0];
    const targetId = chosen?.targetId ?? (await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId;
    // A page left over from an earlier session could be a second consent or sign-in page: this run looks at one page only.
    if (start) for (const page of pages) if (page.targetId !== targetId) await cdp.send('Target.closeTarget', { targetId: page.targetId }).catch(() => undefined);
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    const { userAgent } = await cdp.send<{ userAgent?: string }>('Browser.getVersion');
    if (userAgent) await cdp.send('Network.setUserAgentOverride', { userAgent: userAgent.replace('HeadlessChrome', 'Chrome') }, sessionId);
    // A narrow, sharp page: the code fills most of the picture, which is read off a phone screen.
    if (start) await cdp.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 720, deviceScaleFactor: 2, mobile: false }, sessionId);

    const where = async (): Promise<URL | undefined> => {
      try {
        const history = await cdp.send<{ currentIndex: number; entries: { url: string }[] }>('Page.getNavigationHistory', {}, sessionId);
        return new URL(history.entries[history.currentIndex]?.url ?? '');
      } catch { return undefined; }
    };
    const first = chosen ? await where() : undefined;
    if (start || !first || !FEISHU_HOST.test(first.hostname)) await cdp.send('Page.navigate', { url: options.url }, sessionId);

    const settle = options.settleMs ?? 2_500;
    let loginSince: number | undefined;
    let last: URL | undefined;
    for (const deadline = Date.now() + options.waitMs; Date.now() < deadline; await pause(500)) {
      const current = await where();
      last = current ?? last;
      if (current && isConsentPage(current)) {
        const attempt = await approveConsent(cdp, sessionId, isConsentPage);
        if (attempt.state === 'clicked') {
          // Feishu's page may stay on the same address after the answer, so there is nothing reliable to wait for: give it a moment, then
          // leave nothing on a Feishu address behind (the next command that uses this profile starts from a blank page, and would
          // otherwise find this page restored and take it for a consent request of its own). `login poll` is what confirms the login.
          await pause(options.afterClickMs ?? 3_000);
          await cdp.send('Page.navigate', { url: 'about:blank' }, sessionId).catch(() => undefined);
          await pause(300);
          return { state: 'approved' };
        }
        loginSince = undefined;
      } else if (current && isLoginPage(current)) {
        loginSince ??= Date.now();
        if (start && Date.now() - loginSince >= settle) {
          const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, sessionId);
          keepRunning = true;
          return { state: 'qr', png: Buffer.from(shot.data, 'base64') };
        }
      } else loginSince = undefined;
    }
    if (last && isLoginPage(last)) { keepRunning = !browser.launched; return { state: 'login_required' }; }
    return { state: 'stuck', where: last ? `${last.host}${last.pathname}` : '' };
  } finally {
    if (keepRunning) browser.cdp.close();
    else await browser.close().catch(() => undefined);
  }
}

export interface DeviceWeb {
  drive: (request: { url: string; mode: 'start' | 'finish'; profileDir: string }) => Promise<DeviceOutcome>;
}

export const realDeviceWeb: DeviceWeb = {
  drive: ({ url, mode, profileDir }) => driveDeviceAuthorization({ profileDir, url, mode, waitMs: mode === 'start' ? 20_000 : 30_000 }),
};

/**
 * `authorize [--qr file.png]`. With --qr: open the pending authorization's link in the hidden browser; if that browser is not logged in
 * to Feishu the sign-in QR goes to the file, otherwise 【授权】 is pressed at once. Without --qr: after the user has scanned, press 【授权】.
 * Either way `login poll` then collects the login.
 */
export async function authorize(status: AuthStatus, paths: Pick<DataPaths, 'qr' | 'browserProfile'>, web: DeviceWeb, qrFile: string | undefined): Promise<Result> {
  const pending = status.pending_login;
  if (!pending || pending.expires_at <= Date.now()) {
    return { status: 'no_pending', message: status.logged_in ? '飞书已经登录，没有待完成的授权' : '没有待完成的飞书授权（或已过期）：先运行 feishu.mjs login start' };
  }
  const url = checkVerificationUrl(pending.verification_uri_complete, pending.user_code);
  await reapStaleQr(paths.qr, paths.browserProfile);
  if (qrFile !== undefined) need(/\.png$/i.test(qrFile), '二维码文件需要是 .png');

  const outcome = await web.drive({ url, mode: qrFile !== undefined ? 'start' : 'finish', profileDir: paths.browserProfile });
  switch (outcome.state) {
    case 'approved':
      clearQr(paths.qr);
      return { status: 'approved', message: '已在浏览器里点了【授权】；现在运行 feishu.mjs login poll 取得登录' };
    case 'qr': {
      const file = writeQr(paths.qr, path.resolve(qrFile!), outcome.png);
      return {
        status: 'qr_ready', qr_file: file,
        message: '二维码已生成。把它发给用户，请其用飞书手机端扫码并在手机上确认（这一次扫码同时让这个浏览器登录飞书网页，之后用到它的插件不会再要求扫码）；几分钟后失效，失效就重新运行本命令。用户说已确认后运行 feishu.mjs authorize（不带 --qr）',
      };
    }
    case 'login_required':
      return { status: 'login_required', message: '还停在扫码页：用户还没扫码或二维码已失效。让用户扫码，或重新运行 feishu.mjs authorize --qr <png> 生成新的二维码' };
    case 'stuck':
      return { status: 'stuck', where: outcome.where, message: '页面既不是扫码页也不是授权页，或【授权】点了没反应；运行 feishu.mjs login poll 看是否已授权，没有则重新运行 --qr' };
  }
}
