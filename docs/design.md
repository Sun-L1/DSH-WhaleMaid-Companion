# 桌宠设计规格

## 1. 形态

- 一个 `dsh.client` 浏览器插件，注册进 **`shell.overlay`**：ui-layout 声明的帧级悬浮层
  （`position:absolute; inset:0; z-index:20; pointer-events:none`，直接子元素默认 `pointer-events:auto`；
  本插件用 `.dsh-pet-root.dsh-pet-root { pointer-events:none }` 让整层继续点击穿透，只在角色与菜单上恢复事件）。
  该槽位上游零占用者，属于"加一个 id 而不是替换"的增量座位。
- 不使用 `document.body` 注入；弹出菜单也在自己这棵子树里（不 portal）。
- 样式在 `apply()` 时以 `<style data-plugin="dsh-client-ui-pet">` 注入，`dispose()` 时移除。

## 2. 状态推导

```
occupancy = projectedTokens ?? pressureTokens  (来自 contextPressure 投影)
percent   = min(100, round(occupancy / contextWindow * 100))
level     = 0..4  按 [40, 65, 85, 95] 分级，降级需跌破「上一级阈值 − 3」
mood      = quota(粘性) → sleep(>90s 无活动) → working(running) → idle
eye       = level ≥ 4 → sleep；level ≥ 2 → half；眨眼时各降一档（open→half→closed）
sweat     = compaction/summary 或 CONTEXT_WINDOW_EXCEEDED 后 1.4s
fault     = QUOTA/HTTP_402 → 空碗（粘性）；RATE_LIMIT/AUTH → 8s 提示后自清
```

| 级别 | 视觉 | 台词 |
|---|---|---|
| L0 | 正常呼吸（3.4s/7px） | — |
| L1 | 呼吸变慢 + 降饱和 6% | — |
| L2 | 半闭眼贴片 + 慢动作 | “有点累了…” |
| L3 | 再慢 + 倾斜感（动画时长 6.4s） | “上下文快满了…” |
| L4 | 近闭眼（sleep 贴片）+ 8s 周期 | “要压缩了…” |
| 擦汗 | 汗滴飞出 1.4s + 星光 | “呼——轻松多了！” |
| 空碗 | 双手前方空碗 + 轻微晃动 | “余额不足了，碗是空的…” |

## 3. 交互

| 手势 | 行为 |
|---|---|
| 拖拽（移动 > 4px） | 跟随指针、限制在视口内、松手把位置写进偏好（视口比例） |
| 单击 | 星光 + 台词（2.5s 限流）；空碗状态下单击 = 收起碗 |
| 双击 | 比心 + 台词 |
| 右键 | 菜单（`role="menu"`，Esc 关闭） |
| Tab/Enter/方向键 | 聚焦、开菜单、按 16px 步进移动 |

偏好（`localStorage['dsh-pet:v1']`，读取失败即退回默认，写入失败只告警）：
`enabled / size / showMeter / reduceMotion / lang / fx·fy / hiddenUntil / hiddenSessions / debug`。

## 4. 无障碍与礼貌

- `role="button"` + `aria-label` + `aria-haspopup="menu"` + `title`；菜单项是原生 `button`。
- `prefers-reduced-motion: reduce` 或设置页开关 → 关闭一切 CSS 动画与眨眼。
- 单条 `requestAnimationFrame` 循环，`visibilitychange → hidden` 时暂停；只在状态真的变化时 `publish()`
  （动画本体是 CSS transform，不触发布局）。
- 视口宽度 < 420px 时整个桌宠不渲染（避免挡住输入框）。

## 5. 素材管线（`tools/build_assets.py`）

1. **底板识别**：自动取图像边框环带的中位色作为底板色（不再硬编码）。抠图源按优先级取第一个存在的：
   **键色底** `#00FF00`（最优） → 浅灰底 `#EDECEC` → 原始近白底附图。三通道极差 ≥ 60 即判为键色底。
2. **背景**：用**从边界起的内向泛洪**找背景（容差 8），被轮廓包住的白色（围裙、袜子、高光）因此不会被挖洞。
3. **封闭洞**（呆毛圈里、两腿之间、发丝之间）：
   - **键色底**：判定无歧义 → 所有与键色同容差的封闭块都当洞抠掉（实测 12 个洞、23629px）。
   - **中性底（近白/浅灰）**：角色自己的白与底板色重叠（实测灰底下围裙平整区就在 237 附近，与底板
     (237,236,236) 无法区分）→ **保守跳过**并在报告写 `enclosed_holes = skipped (...)`。
     曾试过"颜色统计 + 外圈亮度"判定，实测在围裙上咬出 2122/1633/1382px 的假洞，已回退。
4. **逐像素去键**（键色底）：过渡带取 `SOFT_BAND_RADIUS = 3`，并且**把全图带键色成分的像素也纳入**
   （发丝缝里透出的绿、半透明混合离边界可能超过 3px）。对每个这样的像素解
   `a = (p−B)·(F−B)/|F−B|²`（F 取邻近**确定前景**像素，**必须排除像素自身与整个过渡带**，
   否则 α 恒等于 1——这正是第一版绿边去不掉的根因），再对 B 反预乘、做 despill
   （键色通道压回 `max(其它通道)+12`）。实测成品不透明像素的 `g−max(r,b)` 最大值为 **0**。
5. **防渗色填充**：贴近剪影的 3 层透明像素用邻接前景色填充（`bleed_fill`）。
   为什么必须做：缩放（LANCZOS）会从"alpha=0 但 RGB 仍是底板色"的像素取色，把底板色渗进边缘
   若干像素 → 成品出现一圈底板色描边/光晕（绿底表现为绿边，浅灰底表现为灰白毛边）。
   alpha 本身仍为 0，只改 RGB。
6. **水印与噪点**：配置的擦除矩形先把底部水印涂成底板色，再按"只保留最大连通域 + 与其包围盒相交的碎片"
   剔除噪点。
7. **裁切 → 编码**：裁到 `bbox`，用**预乘缩放**（`resize_rgba`：预乘 → 缩放 → 反预乘）缩到 520px 宽，
   再过一遍 `final_despill`；素材统一用**无损 WebP**。
   三个都是踩过的坑：
   - 直接对 RGBA 做 LANCZOS 会从"alpha=0 但 RGB 还是底板色"的像素取色 → 边缘一圈底板色描边；
   - 反预乘在 α≈1 的像素上会把颜色放大成饱和色（实测出现过 `(0,255,0)` 的纯绿点）→ 分母设下限；
   - **有损 WebP 会在深色发丝上搬动色度**（4:2:0 子采样），q85 下重新引入 100 个可见绿色像素、
     q95 仍有 57 个，无损编码为 0。主图因此从 91KB 涨到约 375KB（仍全部内联）。
   导出主图 + 96×96 头像 + 6 张眼态贴片；内联总量 ≈ 430KB，bundle ≈ 630KB。
8. **眼态贴片**：
   - 有手绘版（`assets/source/eyes-{closed,drowsy,sleep}.png`，画幅容差 ±4px 自动归一）→ 直接裁眼框，
     套**羽化椭圆蒙版**（眼角发丝保留在椭圆外，矩形接缝消失），标记 `source: hand-authored`；
   - 没有则程序合成：眼框内容向上压扁到 60%/20%/12%，下方用脸颊条拉伸补位，同样过羽化椭圆。
9. **人工审阅**：`assets/preview.png`（棋盘格 3 档尺寸 + 深底 + 眼态 2× 放大 + 姿态缩略图）。
10. **溯源**：manifest 同时记录**抠图源**（`source`，含检测到的底板色与是否键色底）与**原始附图**
    （`provenance`），两者哈希都进门禁。

替换成真实美术（例如 GPT 生成的闭眼/半闭眼图）时：把图放到 `assets/source/`，改 `EYE_BOXES`
与之对齐，`squash_eye` 那一步换成"从新图裁同一眼框"，其余管线不变——这一步已经实现：
`assets/source/eyes-<state>.png` 存在且**画幅与源图一致**时优先使用（`source: "hand-authored"`），
不一致则在报告里列为 `eye_override_rejected` 并回落到合成，绝不静默错位。

## 5b. 手绘姿态（可选）

`assets/source/poses/<name>.png` 存在时，`build_poses()` 会对每张图跑同一套抠图管线，然后
**按裁切高度归一到待机立绘同高**（宽度按比例，上限 480px，WebP q80）。这样切换姿态时角色在屏幕上
的高度不变；运行时用 `position:absolute; bottom:0; left:50%; transform:translateX(-50%)` 底部对齐 + 水平居中，
并以 `key` 变化触发 0.26s 淡入，形成跨姿态的交叉淡出观感。

状态 → 姿态映射（`poseFor`，纯函数，有用例）：`drag > bowl(quota) > wipe(sweat) > exhausted(L4) >
sleep > working > tired(L2/L3) > idle`。

叠加规则：只有在“画面上就是待机立绘”时才叠眼态贴片（有姿态时表情由该姿态表达）；有 `poses/bowl`
时空碗 SVG 自动让位，其余程序化道具（汗滴、Zzz、星光、工作小点）继续叠加。

## 6. 失败与降级

| 情况 | 行为 |
|---|---|
| 没有当前会话 / `binding()` 未就绪 | 只显示待机，不抛错 |
| 会话没水合事件窗口 | 只用投影；擦汗/空碗退化为投影骤降 + `lastAgentError` 文本兜底 |
| `contextWindow` 缺失 | 占用率为 `null`，不显示疲劳（不猜模型容量） |
| 切换会话 | 解绑旧会话的全部订阅，疲劳/故障按新会话重算 |
| 宿主缺 `sessions` / 缺投影 / 事件窗口形状异常 | 每个回调都包 try/catch，只 `console.warn` 一次并把错误放进快照的 `error` 字段 |
| 卸载 / HMR | `ctx.effect` 清理：移除样式、取消 rAF、解绑全部订阅、清掉 `window.__dshPet` |

## 7. 自测钩子

默认关闭。打开方式：右键菜单「开发者自测」，或 `localStorage['dsh-pet:debug']='1'`。
打开后可用 `window.__dshPet.simulate({ level, quota, occupancy, sweat, bubble, mood, eye })` 与
`window.__dshPet.clear()`，用来在几秒内演示 L0→L4、擦汗、空碗、被拎起来，不必等真实长会话或真实欠费。
菜单里另有「困倦含泪」一项：三种眼态都可被单独强制出来（没有任何一种表现被删掉）。

## 8. 实现细节（README 里不展开的部分）

### 8.1 为什么安装可以免重启

`%DSH_HOME%\profiles\<profile>\cordis.patch.yml` 属于 `patchReload: 'live'` 的用户层：CLI 会监听它并
整体重放（`apps/cli/src/profile-boot.ts`），因此新加的 `insert` 行会在**运行中的进程里**挂载成 Loader 行；
`client-modules` 监听 `internal/plugin` 后重算启动图，并把该行的 `./client` bundle 提供到 `/plugins`
（`packages/client/modules/src/index.ts`）。所以安装脚本只写文件、不重启。

两点注意：

- 浏览器不会自动拿到图变化（本 profile 通常关闭 `client-hmr`），装完/改完要**手动刷新**；
- 行一旦挂载，bundle 内容会被快照进内存，改代码后要用 `dev_reload.ps1`（临时 `disabled` → 再启用）
  触发重新挂载，再 **Ctrl+Shift+R**（bundle 响应带 immutable 缓存头）。

### 8.2 读取的客户端接口（全部只读）

| 读的东西 | 客户端接口 |
|---|---|
| 当前会话 | `ctx.sessions.list` 的 `current`（`shell.overlay` 是 root 作用域，拿不到 `useProjection`） |
| 运行中 / 失败 | `ctx.sessions.binding(id).session` 快照：`running`、`promptError.error.code`、`lastAgentError` |
| 上下文占用 | `binding.session.projections.faceOf('contextPressure')` → `{ contextWindow, pressureTokens, projectedTokens }` |
| 会话事件 | `binding.eventSource`（`ObservableSnapshot<SessionEventWindow>`）→ `compaction/*`、`turn/end`、`assistant/message` |

占用率口径与仓库内 `packages/client/ui-conversation/src/client/context-occupancy.ts` 一致：
`percent = min(100, round((projectedTokens ?? pressureTokens) / contextWindow * 100))`。
余额判定只认 `turn/end.reason.error.code ∈ {QUOTA, HTTP_402}`；`RATE_LIMIT` 只抖一下，
`CONTEXT_WINDOW_EXCEEDED` 走「满了」的汗滴，另有 `lastAgentError` 文本同族规则兜底
（与宿主 `packages/llm/llm/src/error.ts` 的 `isQuotaExceededError` 对齐）。

### 8.3 目录结构

```
plugin/    要装进 profile 的包：lib/index.js（空 Node 半边）、lib/client.js（已构建，可读不压缩）、
           src/client.body.js（手写逻辑体）、src/assets.gen.json（素材清单+内联 data URI）、tests/
assets/    character.png / preview.png / icon.png（⚙ 构建产物）+ source/（绿底原图、眼态、七张姿态、sources.json）
docs/      design.md（本文）、cost-and-risk.md、acceptance.md、media/（README 效果图）
tools/     build_assets.py / build_media.py / build_bundle.mjs / verify_plugin.mjs / run_tests.mjs
           install_live.ps1 / uninstall.ps1 / dev_reload.ps1 / check_live.mjs / check_publish_safe.mjs
```

`assets/source/sources.json` 决定抠图输入：`cutSource`（绿底原图）、`fallbackSources`、`eraseRects`
（只作用于 cutSource，用于擦掉水印）、`provenance`（记进 manifest 并纳入门禁）。

### 8.4 构建与门禁

```powershell
python tools\build_assets.py      # 源图 → assets/character.png + plugin/src/assets.gen.json
python tools\build_media.py       # 素材 → docs/media/{hero.gif,moods.png,drag.gif}
node   tools\build_bundle.mjs     # src/client.body.js + src/assets.gen.json → plugin/lib/client.js
node   tools\run_tests.mjs        # 29 个用例（纯函数 + 假 ctx 集成，装配真实产物）
node   tools\verify_plugin.mjs    # 12 项硬门禁：契约 / 零网络零注入 / 素材哈希 / 编码与几何
```

三者都支持 `--check`：不写盘，只比对磁盘产物是否与当前输入一致（漂移即退出码 1）。
`build_media.py` 默认用 Pillow 内置位图字体（ASCII），系统有 CJK 字体时自动用中文，也可 `--font` 指定；
解析到的字体路径记在 `docs/media/media.json` 里，`--check` 会一并报告。

### 8.5 迁移到桌面版 Harness

桌面版渲染的是**同一个** `@deepseek-ai/dsh-web-frontend`，扫的是**同一张** `dsh.client / platform: 'web'`
插件表，所以这份代码零改动可用；但桌面版读 `%DSH_HOME%\profiles\desktop`，且其插件管理器只接受
**registry 精确版本**（拒绝 `file:`，要求 `dsh.bundle.patch` + peerDependencies）。到时二选一：
发到 npm 后用桌面版插件管理器安装，或复用同一套手工放置法写进 `profiles\desktop`。
本插件不注入 `ctx.webServer`，也不依赖 `webRuntime` / `webStartup` / `directory-picker` / `client-hmr`
这些桌面版被禁用的行，因此不存在 web-only 依赖。
