# 其他插件怎么调用 feishu

requirement-auto 和 gof-ad-audit 不再各自登录飞书，飞书的一切都经由这个插件：同一个登录、同一套白名单接口、同一个无头浏览器，用户只扫一次码。调用方只依赖下面这些约定，不 import 这个插件的代码，也不读它的文件。

## 找到 feishu.mjs

插件本身就是一个命令行：`<feishu 插件根>/server/dist/feishu.mjs`，用 Node.js 24+ 运行（Node 调用方用 `process.execPath`）。调用方按顺序找：

1. 环境变量 `FEISHU_PLUGIN`：feishu.mjs 的绝对路径（开发和测试用）。
2. 从调用方自己的脚本位置往上逐级找，每一级 `<A>` 试这几处（取第一个存在的；同一处有多个版本时取版本号最大的）：
   - `<A>/feishu/server/dist/feishu.mjs`：两个插件文件夹并排（lark-agent 的 `plugins/`）
   - `<A>/feishu/<版本>/server/dist/feishu.mjs`：Codex 的插件缓存，同一个 marketplace（lark-agent 装的都在 `.codex/plugins/cache/lark-agent/` 下）
   - `<A>/*/feishu/<版本>/server/dist/feishu.mjs`：Codex 的插件缓存，不同的 marketplace（桌面版各自添加的仓库）
   - `<A>/feishu-plugin/plugins/feishu/server/dist/feishu.mjs`：开发时并排的仓库（`D:\project\feishu-plugin`）

找不到就告诉用户需要先安装 feishu 插件，不要自己去连飞书。

## 环境

子进程直接继承调用方的环境：`LARK_AGENT_USER_DIR`（用户目录，数据在 `<用户目录>/feishu/`）、`LARK_AGENT_USER_OPEN_ID`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`。命令没有用户参数，服务谁由宿主给的环境决定。

## 命令

| 调用方 | 命令 | 输出 |
|---|---|---|
| 程序（Node） | `feishu.mjs serve` | 每行一个请求 `{"id":…,"command":"…","input":{…}}`，每行一个回复 `{"id":…,"reply":{"ok":true,"data":…}}` 或 `{"ok":false,"error":{"kind","message","code?"}}`；回复按完成顺序、带请求的 id；输入结束、手上的请求都答完后退出。一个调用方进程起一个就够 |
| 程序（任意语言） | `feishu.mjs bridge <命令>`，参数 JSON 走 stdin | 一行同样的回复；退出码 0 或 2 |
| 技能（模型） | `login start/poll/status/logout/check`、`authorize [--qr]`、`doc fetch`、`doctor`、`info` | 一行 JSON；拒绝时 `{"status":"blocked","reason":…}`，退出码 2 |

桥命令（`serve` 和 `bridge` 共用）见 `dev/feishu-sdk/src/bridge.ts` 的 `COMMANDS`：`info`、`auth-status`、`auth-verify`、`auth-login`、`auth-poll`、`auth-logout`、`auth-check-scopes`、`api-get`（只读白名单路径）、`sheets-revision`、`sheets-export`、`sheets-cells-set`（只有 `allow_overwrite:false`）、`sheets-create`、`sheets-dropdown-add`、`docx-blocks`、`docx-insert`、`docx-set-texts`。协议版本是 `info.bridge`（现为 `feishu-sdk-bridge/1`），调用方遇到不认识的版本应拒绝工作；只加命令和字段不升版本，改变已有命令的含义才升。

`error.kind`：`config`、`auth_required`、`login_denied`、`login_expired`、`identity_mismatch`、`scope_missing`、`invalid_request`、`occupied`（服务端拒绝覆盖非空单元格）、`unknown_result`（写入可能已生效：只能回读核对，绝不重发）、`network`、`api`。消息已去掉令牌和应用密钥，可以原样转述。

## 浏览器

`info` 的 `browser_profile` 是这个用户无头浏览器的资料目录，里面有飞书网页登录态（`authorize --qr` 扫码时留下）。网站登录走公司飞书单点登录的插件（requirement-auto 的 CLS）在这个目录上打开自己的页面，用户就不用再扫一次。同一时间只能有一个进程驱动它：锁是资料目录旁边的 `browser-profile.lock`（`{"pid","at"}`，进程结束或 15 分钟没续就算作废），浏览器的调试端口在资料目录里的 `DevToolsActivePort`。用到这个目录的插件必须用同样的锁（requirement-auto 的 `chromium.ts` 和这里的 `browser.ts` 是同一份实现，要改一起改），并且在持有锁的时候不要调用 feishu.mjs 里会打开浏览器的命令（`authorize`），否则两边互相等。

## 权限

一次登录申请所有调用方需要的权限（`dev/feishu-sdk/src/config.ts` 的 `REQUIRED_SCOPES` 加 `docx:document` 和 `offline_access`）。调用方需要新权限时加在那里，并在飞书应用后台开通；调用方用 `auth-check-scopes` 检查自己用到的那几个。
