import fs from 'node:fs';
import path from 'node:path';
import { attachBrowser } from './browser.ts';
import { Blocked } from './errors.ts';

/*
 * The sign-in QR picture. `authorize --qr` leaves the hidden browser running on Feishu's sign-in page and a picture of its code in the
 * user's delivery folder; the record says where the picture is and since when, so that the picture can be removed once the login is
 * done, and a browser nobody scanned for is not left running for good.
 */
export interface QrRecord { path: string; created_at: number }

export const QR_MAX_AGE_MS = 15 * 60_000;

export function readQr(file: string): QrRecord | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<QrRecord>;
    return typeof value.path === 'string' && typeof value.created_at === 'number' ? { path: value.path, created_at: value.created_at } : undefined;
  } catch { return undefined; }
}

/** Whether the picture may go to this file: a new one, or the previous picture. Asked before a browser is left waiting for a scan. */
export function checkQrTarget(recordFile: string, target: string): void {
  const file = path.resolve(target);
  if (!/\.png$/i.test(file)) throw new Blocked('二维码文件需要是 .png');
  if (fs.existsSync(file) && readQr(recordFile)?.path !== file) throw new Blocked('这个文件已存在，不覆盖；换一个新的 .png 文件名');
}

/** Writes the picture. A file that is not the previous picture is never overwritten. */
export function writeQr(recordFile: string, target: string, png: Buffer, now: () => number = Date.now): string {
  checkQrTarget(recordFile, target);
  const file = path.resolve(target);
  const previous = readQr(recordFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
  if (previous && previous.path !== file) fs.rmSync(previous.path, { force: true });
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  fs.writeFileSync(recordFile, JSON.stringify({ path: file, created_at: now() }), 'utf8');
  return file;
}

/** The login is done (or given up): the picture and its record go away. */
export function clearQr(recordFile: string): void {
  const record = readQr(recordFile);
  if (record && /\.png$/i.test(record.path)) fs.rmSync(record.path, { force: true });
  fs.rmSync(recordFile, { force: true });
}

/** Closes the hidden browser of this profile if one is running (left waiting for a scan, say). */
export async function closeBrowser(profileDir: string): Promise<void> {
  const browser = await attachBrowser(profileDir);
  if (browser) await browser.close();
}

/** A code nobody scanned in a long time: close the hidden browser waiting for it and remove the picture. */
export async function reapStaleQr(recordFile: string, profileDir: string, now: () => number = Date.now): Promise<void> {
  const record = readQr(recordFile);
  if (!record || now() - record.created_at < QR_MAX_AGE_MS) return;
  await closeBrowser(profileDir);
  clearQr(recordFile);
}
