# @dsh-local/dsh-client-ui-pet

DeepSeek Harness 的桌宠**客户端插件**（浏览器半边）。它在 `shell.overlay`（帧级悬浮层）里渲染一个角色，
只读取当前会话已有的数据：上下文占用投影、压缩事件、失败码、运行中标志。

- `dsh.client.platform: 'web'`，`exports['./client']` 是经典脚本工厂（`window.__ModuleLoader__.load({...})`）
- Node 半边（`lib/index.js`）是**空的** `apply()`：不注册工具、不监听事件、不做 IO
- 唯一基线依赖是 `react`（`PLATFORM_MODULES` 里的种子模块）
- 产物可读、不压缩、不混淆：安装前请直接审阅 `lib/client.js`

## 数据来源（全部已在浏览器里）

| 用途 | 客户端接口 |
|---|---|
| 当前会话 | `ctx.sessions.list` → `current` → `ctx.sessions.binding(id)` |
| 运行中 / 失败 | `binding.session` 快照：`running`、`promptError.error.code`、`lastAgentError` |
| 占用率 | `binding.session.projections.faceOf('contextPressure')` |
| 压缩 / 回合事件 | `binding.eventSource`（`SessionEventWindow`） |

## 代价

token = 0（不注册工具、不注入提示、不发消息、不调模型）；出网 = 0；host 代码 = 0；
持久化只有 `localStorage` 里的偏好（`dsh-pet:v1`）。`tools/verify_plugin.mjs` 用静态规则强制前两条。

## 构建

本包**不需要**构建工具链：`lib/client.js` 由仓库内的 `tools/build_bundle.mjs` 由
`src/client.body.js` + `src/assets.gen.json` 拼装（确定性，支持 `--check`）。

## 安装

见仓库根目录的 `README.md`（默认走免重启的 live patch 路径）。
