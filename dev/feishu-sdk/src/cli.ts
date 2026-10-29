import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { FeishuApi } from './api.ts';
import { FeishuAuth } from './auth.ts';
import { INPUT_COMMANDS, runBridge, type BridgeReply } from './bridge.ts';
import { loadApp, type Endpoints } from './config.ts';
import { fetchDoc } from './docs.ts';
import { Blocked, need, toPayload } from './errors.ts';
import { migrateLegacy } from './legacy.ts';
import { expectedOpenId, resolveDataPaths } from './paths.ts';
import { authorize, realDeviceWeb, type DeviceWeb } from './web-login.ts';

/*
 * feishu.mjs, the plugin's one command line. Every command prints one line of JSON on stdout (`serve` one per request) and exits with 0,
 * or with 2 when it was refused or the answer is not ok ({"status":"blocked","reason":…} for a refusal).
 *
 *   info | doctor                          what is configured; doctor also needs a login with every permission
 *   login start [--extra-scope <scope>]…   a device authorization: link and code (the link is for the QR below, not for the chat)
 *   authorize [--qr <file.png>]            complete it in this user's hidden browser: the sign-in QR for the user, then 【授权】
 *   login poll [--wait <s>] | status | logout | check
 *   doc fetch --url <link> --output <file.md> [--sheet <tab>]
 *   bridge <command>                       for other plugins: one bridge command, its JSON input on stdin (see bridge.ts)
 *   serve                                  for other plugins: one {"id","command","input"} per line on stdin, one {"id","reply"} per line out
 */

type Result = Record<string, any>;
/** Whom a command serves (the environment the host started this process with), and the test seams: a local Feishu, a browser stand-in. */
export interface Context { env: NodeJS.ProcessEnv; endpoints?: Endpoints; web?: DeviceWeb }
const SHOWN = new Set(['auth_required', 'config', 'identity_mismatch', 'scope_missing', 'invalid_request', 'login_denied', 'login_expired']);
const NO_ACCESS = new Set([1770032, 131006, 1310213]);
const LOGIN_TODO = 'Feishu: run feishu.mjs login start (keep its link to yourself), then feishu.mjs authorize --qr feishu-login.png and send the QR image to the user only, to scan with the Feishu phone app';

function parse(args: string[], options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>, positionals = false) {
  try {
    return parseArgs({ args, options, allowPositionals: positionals, strict: true });
  } catch (error) { throw new Blocked((error as Error).message); }
}

/** The bridge's answer, or a refusal that carries its reason (already scrubbed of credentials by the bridge). */
const bridged = (ctx: Context) => ({ env: ctx.env, ...(ctx.endpoints ? { endpoints: ctx.endpoints } : {}) });

async function call(command: string, input: unknown, ctx: Context): Promise<any> {
  const reply = await runBridge(command, input, bridged(ctx));
  if (reply.ok) return reply.data;
  const { kind, message } = reply.error;
  throw new Blocked(SHOWN.has(kind) ? message : `飞书接口调用失败（${kind}${reply.error.code !== undefined ? `，错误码 ${reply.error.code}` : ''}）：${message}`);
}

/**
 * Is the login good right now? Unlike `status` this asks Feishu with the stored login (renewing it once if Feishu turns the token down, which
 * also keeps an idle login alive), so a login the user withdrew or let lapse is found here and not halfway through a task.
 * ok | login_required | identity_mismatch | scopes_missing | unreachable | blocked.
 */
export async function checkLogin(ctx: Context): Promise<Result> {
  const reply: BridgeReply = await runBridge('auth-verify', undefined, bridged(ctx));
  if (reply.ok) {
    const data = reply.data as Result;
    const missing: string[] = Array.isArray(data?.missing_scopes) ? data.missing_scopes : [];
    const who = { ...(data?.name ? { name: data.name } : {}) };
    return missing.length
      ? { status: 'scopes_missing', ...who, missing_scopes: missing, reason: '飞书登录缺少必要的权限，需要重新授权', todo: [LOGIN_TODO] }
      : { status: 'ok', ...who };
  }
  const { kind, message } = reply.error;
  if (kind === 'auth_required') return { status: 'login_required', reason: message, todo: [LOGIN_TODO] };
  if (kind === 'identity_mismatch') return { status: 'identity_mismatch', reason: message };
  if (kind === 'scope_missing') return { status: 'scopes_missing', reason: message, todo: [LOGIN_TODO] };
  if (kind === 'network') return { status: 'unreachable', reason: '暂时连不上飞书，稍后再查；这不说明登录失效' };
  if (SHOWN.has(kind)) return { status: 'blocked', reason: message };
  return { status: 'blocked', reason: '飞书接口调用失败，无法确认登录状态' };
}

async function doctor(ctx: Context): Promise<Result> {
  const info = await call('info', undefined, ctx);
  need(info.app_configured === true, '未配置飞书应用（FEISHU_APP_ID / FEISHU_APP_SECRET），由宿主或管理员配置');
  const auth = await call('auth-status', undefined, ctx);
  need(auth.logged_in === true, '飞书尚未授权：用 feishu.mjs login start 和 feishu.mjs authorize --qr 让用户扫码登录');
  need(!auth.missing_scopes?.length, `飞书登录缺少权限：${(auth.missing_scopes ?? []).join('、')}；需重新授权`);
  return { version: info.bridge, node: info.node, logged_in: true, identity: 'user', user_name: auth.name, open_id: auth.open_id,
    storage: auth.storage, root: info.root, required_scopes: info.required_scopes };
}

async function login(action: string, args: string[], ctx: Context): Promise<Result> {
  switch (action) {
    case 'start': {
      const { values } = parse(args, { 'extra-scope': { type: 'string', multiple: true } });
      const extra = (values['extra-scope'] as string[] | undefined) ?? [];
      need(extra.every(scope => /^[a-z_]+(:[a-z_.]+)+$/.test(scope)), '--extra-scope 需要飞书权限名，如 sheets:spreadsheet:create');
      return call('auth-login', { extra_scopes: extra }, ctx);
    }
    case 'poll': {
      const wait = parse(args, { wait: { type: 'string' } }).values.wait as string | undefined;
      const seconds = wait === undefined ? 40 : Number(wait);
      need(Number.isInteger(seconds) && seconds >= 0 && seconds <= 50, '--wait 必须在 0 到 50 秒之间');
      return call('auth-poll', { wait_ms: seconds * 1000 }, ctx);
    }
    case 'status': parse(args, {}); return call('auth-status', undefined, ctx);
    case 'logout': parse(args, {}); return call('auth-logout', undefined, ctx);
    case 'check': parse(args, {}); return checkLogin(ctx);
    default: throw new Blocked('login 需要 start、poll、status、logout 或 check');
  }
}

async function doc(action: string, args: string[], ctx: Context): Promise<Result> {
  need(action === 'fetch', 'doc 只有 fetch');
  const { values } = parse(args, { url: { type: 'string' }, output: { type: 'string' }, sheet: { type: 'string' } });
  need(typeof values.url === 'string' && values.url, '缺少 --url');
  need(typeof values.output === 'string' && values.output, '缺少 --output（新的 .md 文件）');
  const paths = resolveDataPaths(ctx.env);
  const auth = new FeishuAuth({ paths, app: loadApp(ctx.env, paths), expectedOpenId: expectedOpenId(ctx.env), ...(ctx.endpoints ? { endpoints: ctx.endpoints } : {}) });
  try {
    return await fetchDoc(new FeishuApi(auth), values.url as string, values.output as string,
      typeof values.sheet === 'string' ? { sheet: values.sheet } : {});
  } catch (error) {
    if (error instanceof Blocked) throw error;
    const payload = toPayload(error, await auth.secrets().catch(() => []));
    if (payload.kind === 'auth_required') return { status: 'login_required', reason: payload.message, todo: [LOGIN_TODO] };
    if (payload.kind === 'scope_missing') return { status: 'scopes_missing', reason: payload.message, todo: [LOGIN_TODO] };
    // The user's account may not read this document (docx 1770032, wiki 131006, sheets 1310213, or a plain 403): the owner has to share it.
    if (NO_ACCESS.has(payload.code ?? 0) || /HTTP 403/.test(payload.message)) {
      throw new Blocked(`这个飞书账号没有这份文档的阅读权限（错误码 ${payload.code ?? 403}）：请文档所有者给你开权限，或把内容另存一份发过来`);
    }
    throw new Blocked(SHOWN.has(payload.kind) ? payload.message : `读取飞书文档失败（${payload.kind}${payload.code !== undefined ? `，错误码 ${payload.code}` : ''}）：${payload.message}`);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** One bridge command per line until stdin ends; answers go out as they are ready, each with the id of its request. */
async function serve(ctx: Context): Promise<void> {
  const running = new Set<Promise<void>>();
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: { id?: unknown; command?: unknown; input?: unknown };
    try { request = JSON.parse(line); } catch { request = {}; }
    const id = request.id;
    const job = (async () => {
      const reply: BridgeReply = typeof request.command === 'string'
        ? await runBridge(request.command, request.input, bridged(ctx))
        : { ok: false, error: { kind: 'invalid_request', message: '请求不是 {"id","command","input"}' } };
      process.stdout.write(`${JSON.stringify({ id, reply })}\n`);
    })();
    running.add(job);
    void job.finally(() => running.delete(job));
  }
  await Promise.all(running);
}

export async function main(argv: string[], ctx: Context = { env: process.env }): Promise<{ result: Result | undefined; code: number }> {
  const [group, command, ...rest] = argv;
  const { env } = ctx;
  try {
    // A user whose login an earlier requirement-auto kept gets it moved here first (see legacy.ts). Never stops the command.
    try { await migrateLegacy(resolveDataPaths(env), env); } catch { /* a bad data directory is reported by the command itself */ }
    switch (group) {
      case 'serve': await serve(ctx); return { result: undefined, code: 0 };
      case 'bridge': {
        const name = command ?? '';
        let input: unknown;
        try { const text = INPUT_COMMANDS.has(name) ? (await readStdin()).trim() : ''; input = text ? JSON.parse(text) : undefined; } catch {
          return { result: { ok: false, error: { kind: 'invalid_request', message: '标准输入不是有效的 JSON' } }, code: 2 };
        }
        const reply = await runBridge(name, input, bridged(ctx));
        return { result: reply, code: reply.ok ? 0 : 2 };
      }
      case 'info': return { result: await call('info', undefined, ctx), code: 0 };
      case 'doctor': return { result: await doctor(ctx), code: 0 };
      case 'login': {
        const result = await login(command ?? '', rest, ctx);
        return { result, code: command === 'check' && result.status !== 'ok' ? 2 : 0 };
      }
      case 'authorize': {
        const qr = parse([command, ...rest].filter((a): a is string => a !== undefined), { qr: { type: 'string' } }).values.qr as string | undefined;
        const paths = resolveDataPaths(env);
        const result = await authorize(await call('auth-status', undefined, ctx), paths, ctx.web ?? realDeviceWeb, qr);
        return { result, code: 0 };
      }
      case 'doc': {
        const result = await doc(command ?? '', rest, ctx);
        return { result, code: result.status === 'saved' ? 0 : 2 };
      }
      default: throw new Blocked('用法：feishu.mjs <login|authorize|doc|doctor|info|bridge|serve> …');
    }
  } catch (error) {
    return { result: { status: 'blocked', reason: error instanceof Error ? error.message : String(error) }, code: 2 };
  }
}
