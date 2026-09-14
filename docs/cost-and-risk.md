# 成本与攻击面

设计前提：**纯浏览器半边 + 只观察不注入**。桌宠的代码永远不进任何一次模型请求，模型看不到它。

## 1. 每个功能的代价

| 功能 | 数据来源 | token 代价 | 新增攻击面 |
|---|---|---|---|
| 待机 / 眨眼 / 拖拽 / 点击 / 双击 / 右键菜单 / 中英切换 | 本地素材 + 本地状态机 | **0** | 0（页面内 DOM/CSS，无网络、无 host 代码） |
| 工作中 / 空闲 / 打盹 | 会话快照 `running` + 90s 无活动 | **0** | 0 |
| 上下文疲劳度 L0–L4 | `contextPressure` 会话投影（`{contextWindow, pressureTokens, projectedTokens}`） | **0** | 0 |
| 压缩后擦汗 + 按新占用量重置 | 会话事件 `compaction/summary`（携带 `shadowedTokenCount`）+ 压缩后投影 | **0** | 0 |
| 余额不足端空碗 | `turn/end` 失败码 `QUOTA`/`HTTP_402`；`lastAgentError` 文本兜底 | **0** | 0 |
| 设置页卡片 + 偏好持久化 | `settings.general.item` 槽位 + `localStorage` | **0** | 0（只写自己命名空间的键） |
| 页面开销 | 内联素材 ≈ 138KB（base64），bundle ≈ 200KB | — | CPU ≈ 1–2%（CSS transform 动画，30fps，后台暂停） |
| 安装写入 | `%DSH_HOME%\profiles\web\node_modules\@dsh-local\**` + patch 文件追加 4 行 | — | 一次性、有备份、可 -WhatIf、可一键卸载 |

对照（**本插件不做**）：

| 如果做了 | 代价 |
|---|---|
| 注册一个工具 / 往系统提示加一行 | 每次请求 +100~300 tokens，长会话线性累积 |
| 让桌宠用模型生成台词 | 每句 +100 tokens 起 |
| 主动查余额（需要 host 半边 + 出网到服务商余额接口） | 0 token，但 host 进程内新增代码 + 出网 + 可能触碰凭据 |
| host 半边把会话事件推给浏览器（SSE 路由） | 0 token，但新增回环路由与会话内容外流路径 |

## 2. 自动化安全门禁（`tools/verify_plugin.mjs`，12 项全为硬失败）

产物里**必须零命中**：`fetch(`、`XMLHttpRequest`、`WebSocket`、`sendBeacon`、`eval(`、`new Function`、
动态 `import(`、`http://`/`https://` 绝对 URL、`.prompt(`、`ctx.remote`、`document.cookie`、
`localStorage.clear(`、`document.body.append/ prepend`。

另外强制：产物只 `require('react')`（基线种子模块白名单）、包无运行时依赖、无 `postinstall`/`prepare`、
Node 半边是空 `apply()` 且无 IO、素材 data URI 可解码且哈希/尺寸与清单一致、bundle 内联的清单与磁盘清单逐字节一致。

## 3. 诚实的残余风险

- **客户端插件与页面同源，且 web shell 不设 CSP。** 任何客户端插件（包括本插件）在能力上都能读页面里的
  会话内容并外发、也能调用 `ctx.sessions...prompt()` 入队模型可见回合。本插件靠"产物可读 + 静态门禁
  零网络/零 prompt"来约束，**这不是安全边界**：安装前请直接审阅 `plugin/lib/client.js`
  （不压缩、不混淆、200KB 左右，人可读）。
- **host 半边为零**：不读文件、不起路由、不 spawn、不碰凭据。Node 半边的 `apply()` 是空函数，
  它的唯一作用是让 Loader 有一行合法条目。
- **读得到的东西**：当前会话的投影值、事件窗口（`compaction/*`、`turn/end`、`assistant/message` 等
  原始会话事件）、以及 `lastAgentError` 字符串。桌宠只用它们推导表情与台词，不落盘、不外发
  （唯一落盘是 `localStorage` 里的偏好：尺寸、位置、语言、开关）。
- **安装路径的权限**：`install_live.ps1` 需要写 `DSH_HOME`（工作区之外），因此需要一次性提权；
  脚本先跑门禁、再备份、幂等插入，`-WhatIf` 可干跑，`uninstall.ps1` 可完全回滚。
- **不做的加固**：不校验 bundle 签名，不做供应链校验。来源只有本目录，哈希记录在 `assets.gen.json`
  与安装备份里，便于事后比对。

## 4. 隐私

- 无遥测、无自动更新、无外链请求；提示词、会话文本、凭据都不会离开浏览器。
- 素材来自使用者提供的附图；道具是项目内联 SVG；没有引入任何第三方素材或依赖。
