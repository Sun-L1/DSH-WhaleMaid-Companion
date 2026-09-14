<div align="center">

# DSH Copilot 桌宠

<img src="assets/icon.png" width="120" alt="桌宠头像">

**住在 Harness Web GUI 里的桌宠** —— 跟着你的上下文一起累、压缩后擦汗、余额见底端空碗。零 token、零出网、零 host 代码。

WhaleMaid是谐音梗

<img src="docs/media/hero.gif" width="420" alt="桌宠演示：呼吸、眨眼、说话">

</div>

## 它做什么

- 💤 **待机**：呼吸 + 眨眼；拖它会「被拎起来」喊你放下，松手记住位置
- 💻 **智能体在跑**：换成正坐着敲笔记本，偶尔碎碎念；这一轮结束会蹦一颗星光
- 😪 **上下文变长**：L1→L4 逐级塌肩、眯眼、冒汗
- 🧻 **压缩之后**：擦汗松口气，疲劳按压缩后的占用重置
- 🥣 **余额不足**：端个空碗提醒你（只认额度耗尽类失败，限流不算）
- 🗣 台词、菜单、设置项均中英双语；跟随系统「减少动效」

<p align="center"><img src="docs/media/moods.png" width="640" alt="八种状态：待机 / 工作中 / 疲倦 / 快撑不住 / 打盹 / 擦汗 / 空碗 / 被拎起来"></p>

## 安装（免重启）

```powershell
node tools\verify_plugin.mjs                            # 先跑静态门禁
pwsh -NoProfile -File tools\install_live.ps1 -WhatIf    # 干跑，看会改什么
pwsh -NoProfile -File tools\install_live.ps1            # 真正安装（写 %DSH_HOME%）
```

脚本只做三件事：备份 `%DSH_HOME%\profiles\<profile>\cordis.patch.yml` → 把 `plugin\` 复制进该 profile 的
`node_modules\@dsh-local\dsh-client-ui-pet\` → 在那个 patch 里幂等插入一行 `insert`。**装完刷新页面（F5）即可**，
不用重启 dsh；若该 profile 关掉了 client-hmr（常见加固做法），手动刷新就行。

## 使用

| 操作 | 效果 |
|---|---|
| 拖动 | 跟着走，她会喊"放我下来"；松手记住位置 |
| 单击 / 双击 | 说话 / 比心 |
| 右键 | 菜单：尺寸 140·190·250px、隐藏 1 小时 / 本会话、中英切换、占用条、重置位置、开发者自测 |
| 设置 → 通用 → 桌宠 | 显示开关、尺寸、占用条、减少动效、重置位置、只读状态行 |
| Tab / Enter / 方向键 / Esc | 键盘可用（无障碍）；视口 < 420px 自动隐藏 |

<p align="center"><img src="docs/media/drag.gif" width="420" alt="拖拽反应：被拎起来 + 连滴汗"></p>

## 验证与卸载

```powershell
node tools\check_live.mjs --token <启动时的 token>   # 文件系统级 + 抓启动图确认已挂载
pwsh -NoProfile -File tools\uninstall.ps1           # 卸载（-WhatIf 干跑）
```

## 另一种安装（正规 pnpm，需重启 dsh）

`dsh plugin --profile web add link:<repo>\plugin` —— bundle 层在启动时读取，所以这条路径**需要重启 dsh**。
⚠ 与上面二选一：同时用会重复插入同一个 `id: ui-pet`。

## 更新与重建

```powershell
python tools\build_assets.py    # 换了源图 / 姿态：重抠素材
python tools\build_media.py     # 重生本文档里的效果图
node tools\build_bundle.mjs     # 合成 plugin\lib\client.js
node tools\run_tests.mjs        # 29 个用例 + 12 项硬门禁（verify_plugin.mjs）
pwsh -NoProfile -File tools\dev_reload.ps1   # 已安装时：同步 + 重挂载，然后 Ctrl+Shift+R
```

## 安全与代价

- **token = 0**：不注册工具、不改提示词、不发消息、不调模型；**出网 = 0**：产物由静态门禁强制无网络 API。
- **host 代码 = 0**：Node 半边是空 `apply()`；唯一落盘是 `localStorage` 偏好。详见 [docs/cost-and-risk.md](docs/cost-and-risk.md)。

## 许可与署名

代码 MIT，见 [LICENSE](LICENSE)；**角色美术不随 MIT 授权**，来源与署名见 [CREDITS.md](CREDITS.md)。

## 已知限制

- 疲劳表现需要宿主上报模型上下文容量；拿不到容量时保持常态，不猜。
- 会话未打开（如后台子会话）时只读投影：擦汗/空碗退化为占用骤降 + 错误文本兜底。
- 多标签页各自保存偏好与位置，不互相同步。
