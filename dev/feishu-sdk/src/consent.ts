import type { Cdp } from './browser.ts';

/*
 * Pressing 【授权】 on Feishu's consent page, the one thing ever done to a page here. The page is only reached through the verification
 * link of this user's own pending device authorization, after the user scanned the sign-in code with their own phone for exactly this
 * login; who ends up logged in is still decided by the login itself (it has to be the user this process serves).
 */

export type ConsentAttempt = { state: 'clicked' } | { state: 'not_ready' };

// Runs in the consent page: where its "授权" button is, if it is drawn and nothing covers it.
const CONSENT_PROBE = `(() => {
  const norm = s => (s || '').replace(/\\s+/g, '');
  const candidates = [...document.querySelectorAll('button, [role="button"], a, div, span')].filter(e => e.children.length === 0 && norm(e.textContent) === '授权');
  const element = candidates.map(e => e.closest('button, [role="button"]') || e).find(e => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !e.disabled && e.getAttribute('aria-disabled') !== 'true';
  });
  let button = null;
  if (element) {
    element.scrollIntoView({ block: 'center' });
    const r = element.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    // Only a button that really is under the pointer: a banner or dialog over it would take the click.
    if (hit && (element === hit || element.contains(hit))) button = { x, y };
  }
  return { href: location.href, button };
})()`;

/** Presses 【授权】 (never 【拒绝】) when the page is a consent page and the button is there. */
export async function approveConsent(cdp: Cdp, sessionId: string, isConsentPage: (url: URL) => boolean): Promise<ConsentAttempt> {
  const probe = await cdp.send<{ result: { value?: { href: string; button: { x: number; y: number } | null } } }>(
    'Runtime.evaluate', { expression: CONSENT_PROBE, returnByValue: true }, sessionId);
  const page = probe.result.value;
  if (!page?.button) return { state: 'not_ready' }; // not a consent page (it also shows the sign-in code), or not drawn yet
  // The page may have moved on since it was looked at: check where it is now.
  let here: URL;
  try { here = new URL(page.href); } catch { return { state: 'not_ready' }; }
  if (!isConsentPage(here)) return { state: 'not_ready' };
  const { x, y } = page.button;
  await cdp.send('Page.bringToFront', {}, sessionId).catch(() => undefined);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
  return { state: 'clicked' };
}
