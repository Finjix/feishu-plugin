# 放进 lark-agent

lark-agent（`D:\project\lark-agent`）把 `plugins/` 下的插件文件夹在启动时装进它自己的 Codex。feishu 是其他插件的基础：requirement-auto 和 gof-ad-audit 的飞书登录和飞书读写都经由它，所以它和它们一起放。

## 怎么放

在 lark-agent 目录里：

```bat
start.cmd stop
robocopy D:\project\feishu-plugin\plugins\feishu plugins\feishu-plugin /MIR
start.cmd
```

- `robocopy` 返回 1 到 7 都是成功；之后更新也用 `/MIR`。
- 日志里出现 `已安装插件`，`http://127.0.0.1:8765/health` 的 `plugins.loaded` 里有 `feishu`，就是装好了。装好后在 Codex 插件缓存里是 `.codex/plugins/cache/lark-agent/feishu/<版本>/`，其他插件就在那里找到它。
- 服务运行中复制没有效果，只在启动时扫描。

## 约定

| 项目 | 内容 |
|---|---|
| 插件在 Codex 里的名字 | `feishu@lark-agent`；技能 `feishu:feishu-login`、`feishu:feishu-docs` |
| 每个用户每一轮的环境变量 | `LARK_AGENT_USER_DIR`（`user/<名>`）、`LARK_AGENT_USER_OPEN_ID`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`（机器人的应用）。Codex 的 shell 和其他插件起的子进程都拿得到 |
| 数据位置 | `user/<名>/feishu/`：`auth.json`、`login.json`、`login-qr.json`、`browser-profile/`。不在 `workspace/` 里，不被 lark-agent 清理，也不会被当作交付文件发出去 |
| 交付 | 登录二维码写在工作目录（`authorize --qr feishu-login.png`），随回复发给用户；`doc fetch` 的输出由调用方决定放哪里 |
| 飞书应用 | 用户身份权限见 README“安装”；没有开通的权限，`login check` 报 `scopes_missing` |

## 旧数据

以前登录在 `user/<名>/requirement-auto/feishu/`，浏览器在 `user/<名>/requirement-auto/cls/browser-profile`。feishu 插件每个命令开始时把还在旧位置、新位置没有的登录和浏览器移过来（`src/legacy.ts`），浏览器正在运行就等下一次。2026-10-29 部署时已经停服务把所有用户的移过一遍。

## 已知限制

- 隔离是逻辑上的：Codex 是 `danger-full-access`，同一个 Windows 账号，防不住被提示词注入后主动去读别人目录（`user/别人/feishu/auth.json`）的模型。
- 每个用户的每一轮 Codex 进程都带着 `FEISHU_APP_SECRET`（插件的设备授权用的就是机器人的应用），见 lark-agent README“插件”一节。
