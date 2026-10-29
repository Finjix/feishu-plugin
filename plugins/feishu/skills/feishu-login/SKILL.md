---
name: feishu-login
description: "Log the user in to Feishu (飞书登录 / 飞书授权 / 扫码登录 / 重新授权) for every plugin that works in Feishu as the user: check the login, and when it is missing or has lapsed, hand the user a QR code to scan with the Feishu phone app (one scan, done in the user's own hidden browser) and collect the login. Other plugins' skills (requirement-auto, gof-ad-audit) send their Feishu login here; also use it when the user asks about or wants to redo their Feishu login, or to log out."
---

# 飞书登录 (Feishu login)

Talk to the user in their language (Chinese unless they write otherwise).

`feishu` = `node <skill>/../../server/dist/feishu.mjs` (`<skill>` = this skill's directory; Node.js 24+). Every command prints one line of JSON; exit code 2 means refused or not ok (`{"status":"blocked","reason":…}` for a refusal).

The login belongs to the user this process serves (the host sets it); there is no user argument, and the tools refuse an account that is not that user's. Tokens never appear in any output.

## Check

`feishu login check` asks Feishu with the stored login (renewing it when Feishu turns the token down). `status`:

- `ok`: logged in (`name` is who).
- `login_required` / `scopes_missing`: log in (below), then check again.
- `identity_mismatch`: the stored login is somebody else's: `feishu login logout`, then log in with the user's own account.
- `unreachable`: Feishu is temporarily out of reach; check again shortly. The login is not lost.
- `blocked`: relay `reason` (an app configuration problem is for the administrator).

## Log in

1. `feishu login start` returns a device authorization (link and code). Keep the link to yourself: the QR below is what the user gets.
2. `feishu authorize --qr feishu-login.png` (in the working directory, so the picture goes to the user with your reply):
   - `qr_ready`: send the image and tell the user to scan it with the Feishu app and confirm on the phone; it expires in a few minutes. This one scan also signs in the user's hidden browser to Feishu web, which other plugins use (requirement-auto's CLS), so they do not ask for another scan.
   - `approved`: the browser was signed in already; no scan needed, go to step 4.
   - No browser on the computer (the command says Chrome or Edge is missing): send the link and code from step 1 instead, to open and confirm in Feishu.
3. When the user says they have scanned: `feishu authorize` (no `--qr`): `approved` = done; `login_required` = the QR expired or nobody scanned: run step 2 again for a fresh one.
4. `feishu login poll` collects the login (`state: authorized`; `pending` = run it again; `denied` / `expired` = start over at step 1), then `feishu login check`.

Run the commands that use the browser (`authorize`, and other plugins' logins and screenshots) one after another, never in parallel: there is one browser per user.

## Other commands

- `feishu login status`: the local record only (no network): logged in, account, permissions, a pending authorization.
- `feishu login logout`: forget the login (the browser's Feishu web session stays).
- `feishu doctor`: app configured, logged in, every permission granted.
