# feishu-plugin

飞书基础插件（Codex 插件，可被 ChatGPT/Codex 桌面版或 lark-agent 加载）。其他插件需要飞书时都调用它：

- **登录**（技能 `feishu-login`）：设备授权，在这个用户自己的**无头浏览器**里完成，用户用飞书手机端扫一次二维码。登录按用户隔离存放，令牌不出现在任何输出里。这次扫码同时让浏览器登录飞书网页，用这个浏览器的插件（requirement-auto 的 CLS 单点登录、进度表截图）不用再扫码。
- **读文档**（技能 `feishu-docs`）：把新版文档、知识库节点、电子表格读成 Markdown 文件（表格按页签成表，第一列是行号）。
- **给其他插件的接口**：`feishu.mjs serve` / `feishu.mjs bridge <命令>`，只开放白名单里的读取、导出和防覆盖写入（`allow_overwrite:false`）。约定见 [docs/for-plugins.md](docs/for-plugins.md)。

调用它的插件：[requirement-auto](https://github.com/Finjix/requirement-auto)（读写创意进度表、需求文档、CLS 登录共用浏览器），它以前自带一套飞书 SDK 层，现在只经由这里。[audit-auto](https://github.com/Finjix/audit-auto)（以前叫 gof-ad-audit）不再读飞书脚本，读审核群用的是机器人自己的应用身份，不调用这个插件。

## 目录

```
.agents/plugins/marketplace.json     本仓库就是一个 marketplace（名字 feishu）
plugins/feishu/                      插件本体，安装和打包的就是这个目录
  plugin.json                        可移植插件清单（Agent Plugins 1.0.0）
  server/dist/feishu.mjs             命令行的打包产物（提交入库，装好即用）
  skills/feishu-login/               技能：检查登录、扫码登录
  skills/feishu-docs/                技能：飞书文档读成 Markdown
dev/                                 开发专用，不进入发布包
  feishu-sdk/                        TypeScript 源码、esbuild 脚本、测试
  package_plugin.mjs                 插件结构检查和打包
docs/for-plugins.md                  其他插件怎么找到它、怎么调用
docs/lark-agent-integration.md       放进 lark-agent
```

## 命令

`feishu` = `node plugins/feishu/server/dist/feishu.mjs`，每个命令输出一行 JSON。拒绝时是 `{"status":"blocked","reason":…}`，退出码 2；`login check` 不是 `ok`、`doc fetch` 没有 `saved` 时也是 2；其余命令的结果看 `status` / `state`，退出码 0。

| 命令 | 做什么 |
|---|---|
| `login check` | 用保存的登录真实地问一次飞书（令牌被拒时续期一次，也让闲置的登录续上）：`ok`、`login_required`、`identity_mismatch`、`scopes_missing`、`unreachable`、`blocked`，要登录时带 `todo` |
| `login start [--extra-scope s]…` | 发起设备授权，返回授权链接和验证码 |
| `authorize [--qr x.png]` | 带 `--qr`：在无头浏览器里打开授权链接，浏览器没登录飞书网页就把扫码页截成 PNG（发给用户扫），已登录就直接点【授权】。不带：用户扫码后点【授权】 |
| `login poll [--wait 秒]` | 收登录（最多等 50 秒）；授权的不是本人就拒绝，并让无头浏览器退出那个人的飞书网页登录，下一次授权会重新出二维码 |
| `login status` / `login logout [--browser]` | 只读本地记录 / 退出（`--browser`：无头浏览器的飞书网页登录也退出） |
| `doc fetch --url <链接> --output x.md [--sheet 页签]` | 读成 Markdown，写新文件（不覆盖） |
| `doctor` / `info` | 自检 / 配置和数据位置（不含任何密钥） |
| `bridge <命令>` / `serve` | 给其他插件：见 [docs/for-plugins.md](docs/for-plugins.md) |

授权页上只点【授权】，绝不点【拒绝】，页面只能是这个用户自己那次设备授权的链接打开的；授权的账号必须是宿主声明的那个用户（`LARK_AGENT_USER_OPEN_ID`），否则令牌不落盘。

## 数据

| 情况 | 位置 |
|---|---|
| lark-agent（宿主给了 `LARK_AGENT_USER_DIR`） | `user/<名>/feishu/`：`auth.json`（登录）、`login.json`（进行中的授权）、`login-qr.json`（等待扫码的二维码记录）、`browser-profile/`（无头浏览器，含飞书网页登录态） |
| 单独用（Codex 桌面版） | `~/.feishu-plugin/default/`，同上；应用凭证写进该目录的 `app.json`（`{"appId":"…","appSecret":"…"}`），或用环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` |

宿主给了 `LARK_AGENT_USER_OPEN_ID` 却没给 `LARK_AGENT_USER_DIR` 时一律拒绝，不回落到共用目录。

**旧数据迁移**：以前登录存在 requirement-auto 的目录里（`user/<名>/requirement-auto/feishu/`，浏览器在 `requirement-auto/cls/browser-profile`）。每个命令开始时先检查：新位置没有、旧位置有，就把 `auth.json`、`login.json`、`login-qr.json` 和浏览器资料移过来（单独用时还有 `~/.requirement-auto/default/app.json`），用户不用重新登录；新位置已有的不覆盖，旧浏览器还在运行就留到下一次。requirement-auto 自己的记录（`cls/account.json`、批次、tmp）不动。代码在 `dev/feishu-sdk/src/legacy.ts`，等所有用户目录里都没有 `requirement-auto/feishu` 了可以删掉。

隔离是逻辑上的：lark-agent 的 Codex 是 `danger-full-access`，同一个 Windows 账号，防得住串号和误操作，防不住被提示词注入后主动去读别人目录的模型。

## 安装

需要 Node.js 24+，别无其他依赖。扫码登录需要本机装有 Chrome 或 Edge（或用 `FEISHU_BROWSER` 指定浏览器路径，requirement-auto 也按它找，两边用同一个浏览器）；没有浏览器时把 `login start` 的链接发给用户在飞书里打开确认。

```bash
codex plugin marketplace add <本仓库路径>
codex plugin add feishu@feishu
```

lark-agent：把 `plugins/feishu` 复制到 lark-agent 的 `plugins/` 下并重启，见 [docs/lark-agent-integration.md](docs/lark-agent-integration.md)。

飞书应用后台要给**用户身份**开通 `wiki:wiki:readonly sheets:spreadsheet:readonly sheets:spreadsheet:read sheets:spreadsheet:write_only sheets:spreadsheet drive:export:readonly docx:document:readonly docx:document offline_access`，并发布版本（requirement-auto 的隔离探测另需 `sheets:spreadsheet:create`，用 `login start --extra-scope sheets:spreadsheet:create`）。

## 开发与测试

```bash
cd dev/feishu-sdk && npm ci             # 一次
npm test                                # 类型检查 → 打包到 plugins/feishu/server/dist → node:test → 插件结构检查
```

改了源码要把 `server/dist/feishu.mjs` 一起提交。发布：`node dev/package_plugin.mjs --output dev/dist/feishu.zip`。

`dev/feishu-sdk/src/` 的 `api.ts`、`auth.ts`、`bridge.ts`、`browser.ts`、`config.ts` 等从 requirement-auto 的 `dev/feishu-sdk/src` 搬过来（2026-10-29，requirement-auto 提交 `f2c9e13` 时的版本），之前的修改历史在那个仓库里。

## 依赖版本

| 依赖 | 版本 |
|---|---|
| Node.js（系统） | ≥ 24 |
| @larksuiteoapi/node-sdk | 1.75.0（已打包进 `server/dist`） |
