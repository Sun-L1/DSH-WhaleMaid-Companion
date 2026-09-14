# 验收步骤

## A. 自动检查（全部在仓库目录内，无需提权）

```powershell
python tools\build_assets.py --check     # 素材与磁盘产物无漂移
python tools\build_media.py  --check     # README 效果图无漂移
node   tools\build_bundle.mjs --check    # bundle 与源文件无漂移
node   tools\run_tests.mjs               # 29 个用例必须全绿
node   tools\verify_plugin.mjs           # 12 项硬门禁必须全绿
node   tools\check_live.mjs              # 安装后的文件系统级校验
```

预期：

| 命令 | 期望 |
|---|---|
| `build_assets.py --check` | `assets: no drift` |
| `build_media.py --check` | `media: no drift (font …, cjk=…)` |
| `build_bundle.mjs --check` | `bundle: no drift (…, sha256 …)` |
| `run_tests.mjs` | `tests 29 / pass 29 / fail 0` |
| `verify_plugin.mjs` | `verify: 12/12 checks passed`，退出码 0 |
| `check_live.mjs` | 4–5 项 PASS（安装后） |

`node --test plugin/tests` 在禁止子进程管道 stdio 的受限环境里会报 EPERM（环境限制，不是用例失败）；
用 `tools/run_tests.mjs`（单进程导入）代替。

## B. 装后即时校验

```powershell
node tools\check_live.mjs --token <启动 dsh 时打印的 token>
```

- `PASS installed package present` / `installed bundle matches the workspace artifact`
- `PASS profile patch declares the ui-pet row` + `ui-pet row is enabled`
- `PASS boot graph contains the pet row`（需要 token：脚本会抓 `GET /` 的 HTML 解析 `window.__DSH_BOOT__`）
- `PASS combo script is served` / `served script registers our package id` / `carries the inline sprite assets`

没有 token 时最后一项会 SKIP，并提示如何补上。

## C. 人工验收（浏览器）

1. **出现**：刷新 Harness 页面（F5；client-hmr 已关闭，不会自动更新）。右下角出现角色，带呼吸动画。
2. **拖拽**：按住拖动 → 跟随指针；松手后刷新页面，位置保持。
3. **点击/双击/右键**：单击出星光 + 台词（有 2.5s 限流）；双击比心；右键出菜单，菜单可改尺寸、
   切中英文、开关占用条、重置位置、隐藏 1 小时 / 本会话隐藏。
4. **设置页**：设置 → 通用 → 桌宠：显示开关、尺寸、占用条、减少动效、重置位置、只读状态行。
5. **无障碍**：Tab 聚焦角色（有 `aria-label`），Enter 打开菜单，方向键移动，Esc 关闭；
   系统开启"减少动效"时动画与眨眼停止。
6. **数据驱动的三种状态**（用开发者自测，几秒内可演示）：
   右键 → 开发者自测 → 打开后：
   - `simulate 96%` → 疲劳 L4（近闭眼、动作极慢、占用条转琥珀色）
   - `simulate compact + wipe` → 擦汗动画 + 占用回落到 17% + 台词
   - `simulate QUOTA` → 双手前方空碗 + “余额不足…”；点一下角色收起碗
   - `clear simulation` → 回到真实数据
7. **真实数据**（可选，慢）：
   - 长会话上下文占用升高 → 疲劳等级随 `contextPressure` 上升，到 L2/L3/L4 会各自出一次台词；
   - 执行 `/compact` → 出现擦汗动画，疲劳按压缩后的占用重置；
   - 真正欠费时（provider 返回 `Insufficient Balance` → 宿主归一到 `code: 'QUOTA'`）→ 出空碗；
     下一次成功回复后自动收起。
8. **控制台**：不应有 `dsh-pet` 之外的报错；若有 `[dsh-pet] xxx failed` 的 warn，把 `error` 字段
   （快照里）与其上下文记录下来。

## D. 卸载验收

```powershell
pwsh -NoProfile -File tools\uninstall.ps1
node tools\check_live.mjs          # 应报 installed package present = FAIL（已删除）
```

刷新页面后：DOM 里不应再有 `[data-dsh-pet]`（F12 里 `document.querySelector('[data-dsh-pet]')` 为 `null`），
无残留样式标签（`style[data-plugin="dsh-client-ui-pet"]` 不存在），控制台无报错。
`backups\<时间戳>\` 保留，可用于比对或手动回滚。

## E. 故障诊断顺序（刷新后没出现桌宠）

1. `node tools\check_live.mjs` → 先确认文件和 patch 行确实就位；
2. 打开 `%DSH_HOME%\profiles\web\cordis.patch.yml`，确认 `id: ui-pet` 那一块**在皮肤 managed 块之前**
   且没有 `disabled: true`，YAML 缩进与其它块一致；
3. 确认包能被解析：文件应位于
   `%DSH_HOME%\profiles\web\node_modules\@dsh-local\dsh-client-ui-pet\lib\client.js`；
4. F12 控制台搜索 `dsh-pet` / `client-modules` / `ModuleLoader`：若报
   `bundle … loaded without registering "<包名>"` 或 `require("react") missed the module table`，
   说明产物契约被破坏（跑 `node tools\verify_plugin.mjs`）；
5. 硬刷新（Ctrl+Shift+R）排除 immutable 缓存；
6. 以上都正常仍不出现：最后手段是用你启动 dsh 的方式重启它（先确认端口已释放），
   并留意启动输出里是否有本行的加载错误（重启会终止发起它的会话）。
