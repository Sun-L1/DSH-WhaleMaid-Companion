/**
 * DSH Copilot 桌宠 — 浏览器半边逻辑体（手写，无构建工具链）。
 *
 * tools/build_bundle.mjs 将本文件包进经典脚本工厂，并在头部注入：
 *   const React = require('react');
 *   const PET_ASSETS = { ... };   // tools/build_assets.py 生成
 *
 * 硬约束（tools/verify_plugin.mjs 强制检查）：
 *  - 零注入：不注册工具、不改系统提示、不发消息、不调模型 → token 代价 0
 *  - 零出网：没有任何网络 API 调用（请求、长连接、信标、动态代码执行）
 *  - 只读：当前会话快照、contextPressure 投影、会话事件窗口（全部已在浏览器里）
 *  - UI 只落在 shell.overlay 槽内；样式注入 <style>，卸载时移除
 */

const VERSION = '0.1.0'
const PREF_KEY = 'dsh-pet:v1'
const DEFAULT_SIZE = 190
const SIZE_CHOICES = [140, 190, 250]
const LEVEL_THRESHOLDS = [40, 65, 85, 95]
const HYSTERESIS = 3
const IDLE_SLEEP_MS = 90_000
const SWEAT_MS = 1_400
const BUBBLE_MS = 3_600
const CLICK_LINE_COOLDOWN_MS = 2_500
const WORKING_LINE_INTERVAL_MS = 35_000
const BLINK_MS = 130

/* ------------------------------------------------------------------ 纯函数 */

/** 与 packages/client/ui-conversation/src/client/context-occupancy.ts 同一口径。 */
function occupancyOf(pressure) {
  if (pressure === null || typeof pressure !== 'object') return null
  const used = pressure.projectedTokens ?? pressure.pressureTokens
  const capacity = pressure.contextWindow
  if (typeof used !== 'number' || typeof capacity !== 'number' || capacity <= 0) return null
  return {
    percent: Math.min(100, Math.round((used / capacity) * 100)),
    usedTokens: used,
    contextWindow: capacity,
  }
}

/** 占用率 → 疲劳级别 0..4；降级需要跌破「上一级阈值 − 3」以免在阈值上抖动。 */
function fatigueLevel(percent, previous) {
  const prev = typeof previous === 'number' && previous >= 0 && previous <= 4 ? previous : 0
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 0
  let level = 0
  while (level < 4 && percent >= LEVEL_THRESHOLDS[level]) level += 1
  if (level < prev) {
    const floor = LEVEL_THRESHOLDS[prev - 1] - HYSTERESIS
    if (percent > floor) return prev
  }
  return level
}

/** turn/end 的稳定失败码 → 桌宠反应；只有 QUOTA / HTTP_402 才端空碗。 */
function classifyTurnError(code) {
  if (typeof code !== 'string' || code === '') return null
  if (code === 'QUOTA' || code === 'HTTP_402') return 'quota'
  if (code === 'RATE_LIMIT' || code === 'HTTP_429') return 'throttle'
  if (code === 'CONTEXT_WINDOW_EXCEEDED') return 'overflow'
  if (code === 'AUTH' || code === 'INVALID_CREDENTIAL' || code === 'HTTP_401' || code === 'HTTP_403') return 'auth'
  return null
}

/** 文本兜底：与 packages/llm/llm/src/error.ts 的 isQuotaExceededError 同族规则。 */
function looksLikeQuotaText(text) {
  if (typeof text !== 'string' || text === '') return false
  return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(text)
    || /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(text)
    || /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(text)
    || /余额不足|欠费|额度不足|配额/.test(text)
}

/** 状态 → 姿态名。没有对应美术时运行时回落到待机立绘（poses 为空对象）。 */
function poseFor(state) {
  if (state.dragging === true) return 'drag'
  if (state.quota === 'quota') return 'bowl'
  if (state.sweat === true) return 'wipe'
  if (state.level >= 4) return 'exhausted'
  if (state.mood === 'sleep') return 'sleep'
  if (state.mood === 'working') return 'working'
  if (state.level >= 3) return 'tired'
  if (state.level >= 2) return 'tired'
  return 'idle'
}

function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)]
}

function readPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY)
    if (raw === null) return {}
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    console.warn('[dsh-pet] preferences unreadable, using defaults', error)
    return {}
  }
}

function writePrefs(prefs) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs))
  } catch (error) {
    console.warn('[dsh-pet] preferences not persisted', error)
  }
}

/** 极小的 observable store：快照引用稳定，供 React useSyncExternalStore 使用。 */
function makeStore(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(patch) {
      snapshot = { ...snapshot, ...patch }
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.error('[dsh-pet] subscriber failed', error)
        }
      }
    },
  }
}

/* ------------------------------------------------------------------ 文案（中英双语） */

const TEXT = {
  zh: {
    'stage.label': 'DeepSeek Harness 桌宠',
    'menu.title': '桌宠设置',
    'menu.hideHour': '隐藏 1 小时',
    'menu.hideSession': '本会话隐藏',
    'menu.showSession': '本会话显示',
    'menu.size': '尺寸',
    'menu.meter': '显示占用条',
    'menu.lang': 'English',
    'menu.dev': '开发者自测',
    'menu.devOff': '关闭自测',
    'menu.reset': '重置位置',
    'menu.about': '关于',
    'about.body': '桌宠只读取当前会话的占用 / 压缩 / 失败状态：不出网、不注入提示、不消耗 token。',
    'line.click': ['在的！', '有什么要我盯着的吗？', '需要我提醒你什么吗？', '我在这儿呢～'],
    'line.drag': ['欸欸…放我下来！', '要摔要摔要摔——', '搬家啦？', '别晃别晃，头晕…'],
    'line.drop': ['呼…这里视野不错', '就放这儿吧～', '站稳了！', '这个角落我喜欢'],
    'line.dblclick': ['欸嘿～', '摸头收到！', '再摸一下也可以哦'],
    'line.working': ['正在干活…', '让我看看这个…', '马上就好～'],
    'line.done': ['搞定！', '做完啦～', '这一轮结束！'],
    'line.level2': ['有点累了…', '上下文开始变长了', '让我歇一下下…'],
    'line.level3': ['呼…有点撑', '上下文好满，快压缩吧', '眼睛快睁不开了…'],
    'line.level4': ['要压缩了…', '太满了，救我…', '脑子转不动了…'],
    'line.sweat': ['呼——轻松多了！', '擦擦汗，重头再来～', '清爽了！'],
    'line.quota': ['余额不足了，碗是空的…', '先充个值吧，我等着', '空碗.jpg（余额见底）'],
    'line.throttle': ['慢一点啦，被限流了', '限流了，歇一会儿'],
    'line.overflow': ['上下文溢出来了！', '装不下了，快压缩'],
    'line.auth': ['凭据好像不对…', '认证失败了，检查一下密钥？'],
    'line.sleep': ['Zzz…', '（打盹中）'],
    'line.wake': ['啊！我醒了我醒了', '谁叫我？'],
    'settings.title': '桌宠',
    'settings.enabled': '显示桌宠',
    'settings.size': '尺寸',
    'settings.meter': '显示上下文占用条',
    'settings.reduce': '减少动效',
    'settings.reset': '重置位置',
    'settings.state': '当前状态',
    'settings.state.idle': '空闲',
    'settings.state.working': '工作中',
    'settings.state.sleep': '打盹',
    'settings.state.quota': '空碗提醒',
    'settings.usage': '上下文占用',
    'settings.fatigue': '疲劳级别',
    'settings.unknown': '未知',
    'settings.note': '只读观察：零出网、零 token、零 host 代码。',
  },
  en: {
    'stage.label': 'DeepSeek Harness pet',
    'menu.title': 'Pet settings',
    'menu.hideHour': 'Hide for 1 hour',
    'menu.hideSession': 'Hide in this session',
    'menu.showSession': 'Show in this session',
    'menu.size': 'Size',
    'menu.meter': 'Show context meter',
    'menu.lang': '中文',
    'menu.dev': 'Developer simulation',
    'menu.devOff': 'Stop simulation',
    'menu.reset': 'Reset position',
    'menu.about': 'About',
    'about.body': 'The pet only reads this session\u2019s occupancy, compaction and failure state: no network, no prompt injection, no tokens.',
    'line.click': ['Yes?', 'Need me to watch something?', 'I\u2019m right here', 'Anything to remind you about?'],
    'line.drag': ['Whoa \u2014 put me down!', 'I\u2019m gonna fall, I\u2019m gonna fall!', 'Moving house?', 'Stop wobbling, I\u2019m dizzy\u2026'],
    'line.drop': ['Phew\u2026 nice view here', 'Right here is fine~', 'Landed!', 'I like this corner'],
    'line.dblclick': ['Hehe~', 'Head pat received!', 'You can do that again'],
    'line.working': ['Working on it\u2026', 'Let me look\u2026', 'Almost there~'],
    'line.done': ['Done!', 'All finished~', 'That round is over!'],
    'line.level2': ['Getting a bit tired\u2026', 'Context is growing', 'Give me a moment\u2026'],
    'line.level3': ['Ngh\u2026 this is heavy', 'Context is nearly full, compact soon', 'My eyes are closing\u2026'],
    'line.level4': ['About to compact\u2026', 'Too full, help\u2026', 'Brain not braining\u2026'],
    'line.sweat': ['Phew \u2014 much lighter!', 'Wiped it off, fresh again~', 'All clear!'],
    'line.quota': ['The bowl is empty \u2014 no balance', 'Please top up, I\u2019ll wait', 'Out of credits\u2026'],
    'line.throttle': ['Easy there, rate limited', 'Throttled \u2014 give it a moment'],
    'line.overflow': ['Context overflowed!', 'No room left, compact please'],
    'line.auth': ['That credential looks wrong', 'Auth failed \u2014 check the key?'],
    'line.sleep': ['Zzz\u2026', '(dozing)'],
    'line.wake': ['Ah! I\u2019m awake', 'Who called me?'],
    'settings.title': 'Pet',
    'settings.enabled': 'Show the pet',
    'settings.size': 'Size',
    'settings.meter': 'Show the context meter',
    'settings.reduce': 'Reduce motion',
    'settings.reset': 'Reset position',
    'settings.state': 'Current state',
    'settings.state.idle': 'Idle',
    'settings.state.working': 'Working',
    'settings.state.sleep': 'Dozing',
    'settings.state.quota': 'Empty-bowl notice',
    'settings.usage': 'Context occupancy',
    'settings.fatigue': 'Fatigue level',
    'settings.unknown': 'unknown',
    'settings.note': 'Read-only observer: no network, no tokens, no host code.',
  },
}

/* ------------------------------------------------------------------ 样式 */

const CSS = `
.dsh-pet-root.dsh-pet-root { position: absolute; inset: 0; pointer-events: none; z-index: 1; font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.dsh-pet-stage { position: absolute; pointer-events: auto; user-select: none; touch-action: none; cursor: grab; transform-origin: 50% 100%; animation: dsh-pet-bob 3.4s ease-in-out infinite; }
.dsh-pet-stage.dsh-pet-dragging { cursor: grabbing; animation-play-state: paused; }
.dsh-pet-body { position: absolute; left: 50%; bottom: 0; transform: translateX(-50%); height: 100%; width: auto; max-width: none; -webkit-user-drag: none; transform-origin: 50% 100%; transition: transform .45s ease; filter: drop-shadow(0 6px 10px rgba(10, 16, 30, .28)); animation: dsh-pet-swap .26s ease-out; }
/* 疲劳时身体也不该是平常状态：没有整帧姿态时，用"塌肩 + 前倾 + 微压"表达。
   有 poses/*.png 整帧时由帧自己表达体态，这里自动让位（:not(.dsh-pet-haspose)）。 */
.dsh-pet-stage.dsh-pet-l1:not(.dsh-pet-haspose) .dsh-pet-body { transform: translateX(-50%) translateY(.8%) rotate(-.5deg); }
.dsh-pet-stage.dsh-pet-l2:not(.dsh-pet-haspose) .dsh-pet-body { transform: translateX(-50%) translateY(1.7%) rotate(-1.1deg); }
.dsh-pet-stage.dsh-pet-l3:not(.dsh-pet-haspose) .dsh-pet-body { transform: translateX(-50%) translateY(2.5%) rotate(-1.7deg); }
.dsh-pet-stage.dsh-pet-l4:not(.dsh-pet-haspose) .dsh-pet-body { transform: translateX(-50%) translateY(3.4%) rotate(-2.4deg) scaleY(.994); }
/* 被拎起来：竖直拉长 + 轻微摇摆 */
.dsh-pet-stage.dsh-pet-dragging .dsh-pet-body { transform: translateX(-50%) rotate(2deg) scaleY(1.02); }
.dsh-pet-eye { position: absolute; pointer-events: none; }
.dsh-pet-stage.dsh-pet-l1 { animation-duration: 4.2s; filter: saturate(.94); }
.dsh-pet-stage.dsh-pet-l2 { animation-duration: 5.2s; filter: saturate(.88) brightness(.98); }
.dsh-pet-stage.dsh-pet-l3 { animation-duration: 6.4s; filter: saturate(.8) brightness(.96); }
.dsh-pet-stage.dsh-pet-l4 { animation-duration: 8s; filter: saturate(.7) brightness(.93); }
.dsh-pet-stage.dsh-pet-working { animation-duration: 1.9s; }
.dsh-pet-stage.dsh-pet-sleep { animation-duration: 6.8s; }
.dsh-pet-reduce .dsh-pet-stage { animation: none; }
.dsh-pet-prop { position: absolute; pointer-events: none; }
.dsh-pet-sweat { animation: dsh-pet-drop 1.4s ease-in forwards; }
.dsh-pet-sweat-loop { animation: dsh-pet-drip 1.25s ease-in infinite; }
.dsh-pet-zzz { animation: dsh-pet-float 3.2s ease-in-out infinite; }
.dsh-pet-pop { animation: dsh-pet-pop .9s ease-out forwards; }
.dsh-pet-bowl { animation: dsh-pet-shake 2.4s ease-in-out infinite; }
.dsh-pet-work { animation: dsh-pet-work 1.1s ease-in-out infinite; }
.dsh-pet-bubble { position: absolute; left: 50%; bottom: 100%; transform: translate(-50%, -6px); max-width: 220px; padding: 7px 10px; border-radius: 10px; background: rgba(18, 21, 30, .92); color: #f2f4f9; box-shadow: 0 6px 18px rgba(6, 9, 18, .35); pointer-events: none; animation: dsh-pet-fade .18s ease-out; }
.dsh-pet-bubble::after { content: ""; position: absolute; left: 50%; top: 100%; margin-left: -5px; border: 5px solid transparent; border-top-color: rgba(18, 21, 30, .92); }
.dsh-pet-meter { position: absolute; left: 50%; top: 100%; transform: translateX(-50%); margin-top: 4px; display: flex; align-items: center; gap: 6px; padding: 3px 7px; border-radius: 999px; background: rgba(18, 21, 30, .82); color: #e8ecf5; font-size: 11px; pointer-events: none; }
.dsh-pet-meter-bar { width: 44px; height: 5px; border-radius: 3px; background: rgba(255, 255, 255, .22); overflow: hidden; }
.dsh-pet-meter-fill { display: block; height: 100%; border-radius: 3px; background: #5ad1a0; transition: width .4s ease; }
.dsh-pet-meter-fill.dsh-pet-warn { background: #e8c05a; }
.dsh-pet-meter-fill.dsh-pet-hot { background: #e8785a; }
.dsh-pet-menu { position: absolute; pointer-events: auto; min-width: 188px; padding: 6px; border-radius: 12px; background: rgba(22, 25, 35, .97); color: #eef1f7; box-shadow: 0 10px 28px rgba(4, 7, 16, .45); border: 1px solid rgba(255, 255, 255, .08); }
.dsh-pet-menu-title { padding: 4px 8px 6px; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: #9aa4bb; }
.dsh-pet-menu button { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.dsh-pet-menu button:hover, .dsh-pet-menu button:focus-visible { background: rgba(255, 255, 255, .1); outline: none; }
.dsh-pet-menu hr { margin: 5px 4px; border: 0; border-top: 1px solid rgba(255, 255, 255, .1); }
.dsh-pet-hint { color: #9aa4bb; font-size: 11px; }
@keyframes dsh-pet-bob { 0%, 100% { transform: translateY(0) rotate(-.6deg); } 50% { transform: translateY(-7px) rotate(.6deg); } }
@keyframes dsh-pet-drop { 0% { opacity: 0; transform: translate(0, -4px) scale(.7); } 25% { opacity: 1; } 100% { opacity: 0; transform: translate(10px, 26px) scale(1); } }
@keyframes dsh-pet-drip { 0% { opacity: 0; transform: translate(0, -1px) scale(.85); } 25% { opacity: 1; } 100% { opacity: 0; transform: translate(2px, 14px) scale(1); } }
@keyframes dsh-pet-float { 0% { opacity: 0; transform: translate(0, 6px) scale(.8); } 40% { opacity: 1; } 100% { opacity: 0; transform: translate(10px, -18px) scale(1.05); } }
@keyframes dsh-pet-pop { 0% { opacity: 0; transform: scale(.6); } 30% { opacity: 1; transform: scale(1.12); } 100% { opacity: 0; transform: translateY(-24px) scale(1); } }
@keyframes dsh-pet-shake { 0%, 100% { transform: rotate(-3deg); } 50% { transform: rotate(3deg); } }
@keyframes dsh-pet-work { 0%, 100% { opacity: .35; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-3px); } }
@keyframes dsh-pet-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes dsh-pet-swap { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .dsh-pet-stage, .dsh-pet-prop { animation: none !important; } }
`

/* ------------------------------------------------------------------ 控制器 */

class PetController {
  position = { x: 0, y: 0 }
  dragging = false
  menuPosition = null
  error = null
  lastAgentErrorSeen = null

  constructor(assets, services) {
    this.assets = assets
    this.services = services
    this.prefs = readPrefs()
    this.lang = this.prefs.lang === 'en' ? 'en' : this.prefs.lang === 'zh' ? 'zh'
      : (typeof navigator !== 'undefined' && /^zh/i.test(String(navigator.language)) ? 'zh' : 'en')
    this.size = SIZE_CHOICES.includes(this.prefs.size) ? this.prefs.size : DEFAULT_SIZE
    this.reduceMotion = this.prefs.reduceMotion === true
    this.level = 0
    this.occupancy = null
    this.fault = null
    this.running = false
    this.sessionId = null
    this.pop = null
    this.popUntil = 0
    this.sweatUntil = 0
    this.bubble = null
    this.bubbleUntil = 0
    this.lastActivityAt = Date.now()
    this.lastLineAt = 0
    this.lastWorkingLineAt = 0
    this.blinkPhase = false
    this.blinkAt = Date.now() + 3_000
    this.lastSeq = null
    this.simulation = null
    this.raf = 0
    this.stopped = true
    this.unbinding = []
    this.disposers = []
    this.warned = false
    const initial = this.compute()
    this.store = makeStore(initial)
  }

  /* ---------------------------------------------------- 基础 */

  t(key) {
    const dict = TEXT[this.lang] ?? TEXT.zh
    return dict[key] ?? TEXT.zh[key] ?? key
  }

  /** 从（投影 / 失败 / 运行 / 交互 / 偏好）推导整份界面状态。 */
  compute() {
    const now = Date.now()
    const simulation = this.simulation ?? {}
    const level = simulation.level ?? this.level
    const occupancy = simulation.occupancy ?? this.occupancy
    const fault = simulation.quota ?? this.fault
    const asleep = this.mood() === 'sleep'
    return {
      visible: this.visibleNow(),
      x: this.position.x,
      y: this.position.y,
      size: this.size,
      dragging: this.dragging === true,
      mood: fault === 'quota' ? 'quota' : this.mood(),
      level,
      occupancy,
      quota: fault === 'quota' ? 'quota' : null,
      fault,
      // 被拎起来时冒汗（与 drag 整帧配合）
      sweat: now < this.sweatUntil || simulation.sweat === true || this.dragging === true,
      eye: this.eyeState(),
      pop: now < this.popUntil ? this.pop : null,
      bubble: now < this.bubbleUntil ? this.bubble : null,
      menu: this.menuPosition,
      showMeter: this.prefs.showMeter === true,
      reduce: this.reduceMotion,
      lang: this.lang,
      debug: this.prefs.debug === true,
      asleep,
      error: this.error ?? null,
    }
  }

  publish() {
    this.store.set(this.compute())
  }

  stageHeight() {
    const sprite = this.assets.sprite
    return Math.round(this.size * (sprite.height / sprite.width))
  }

  visibleNow() {
    if (this.prefs.enabled === false) return false
    const until = typeof this.prefs.hiddenUntil === 'number' ? this.prefs.hiddenUntil : 0
    if (Date.now() < until) return false
    const hidden = Array.isArray(this.prefs.hiddenSessions) ? this.prefs.hiddenSessions : []
    if (this.sessionId !== null && hidden.includes(this.sessionId)) return false
    return true
  }

  /* ---------------------------------------------------- 生命周期 */

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.place(true)
    this.services.localeRegister()
    this.subscribeList()
    this.subscribeWindow()
    this.subscribeMedia()
    this.publish()
    this.loop()
  }

  dispose() {
    this.stopped = true
    for (const dispose of this.unbinding.splice(0)) {
      try {
        dispose()
      } catch (error) {
        console.warn('[dsh-pet] unsubscribe failed', error)
      }
    }
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        console.warn('[dsh-pet] disposer failed', error)
      }
    }
    if (this.raf !== 0) cancelAnimationFrame(this.raf)
    this.raf = 0
    if (typeof window !== 'undefined') window.__dshPet = undefined
  }

  /* ---------------------------------------------------- 订阅 */

  subscribeList() {
    const sessions = this.services.sessions
    if (sessions === undefined || sessions === null || sessions.list === undefined) return
    const read = () => {
      try {
        const current = sessions.list.getSnapshot()?.current
        this.bindSession(typeof current === 'string' ? current : null)
      } catch (error) {
        this.fail('session-list', error)
      }
    }
    this.unbinding.push(sessions.list.subscribe(read))
    read()
  }

  bindSession(sessionId) {
    if (sessionId === this.sessionId) return
    for (const dispose of this.unbinding.splice(1)) {
      try {
        dispose()
      } catch (error) {
        console.warn('[dsh-pet] unbind failed', error)
      }
    }
    this.sessionId = sessionId
    this.occupancy = null
    this.level = 0
    this.fault = null
    this.running = false
    this.lastSeq = null
    this.lastAgentErrorSeen = null
    if (sessionId === null) {
      this.publish()
      return
    }
    let binding
    try {
      binding = this.services.sessions.binding(sessionId)
    } catch (error) {
      this.fail('session-binding', error)
      this.publish()
      return
    }
    if (binding === undefined || binding === null) {
      this.publish()
      return
    }
    const face = binding.session
    if (face !== undefined && face !== null && typeof face.subscribe === 'function') {
      const readFace = () => {
        try {
          const snapshot = face.getSnapshot()
          const running = snapshot?.running === true
          const now = Date.now()
          if (running && !this.running) {
            // 开始干活：说一句 + 记时间戳（中途按间隔再补一句，见 tick）
            this.running = true
            this.lastWorkingLineAt = now
            this.say(pick(this.t('line.working')))
          } else if (!running && this.running) {
            // 这一轮结束
            this.running = false
            this.say(pick(this.t('line.done')))
            this.pop = 'sparkle'
            this.popUntil = now + 900
          } else if (running) {
            this.running = true
            this.lastActivityAt = now
          }
          const code = snapshot?.promptError?.error?.code
          if (typeof code === 'string' && code !== '') this.noteFailure(code)
          const agentError = typeof snapshot?.lastAgentError === 'string' ? snapshot.lastAgentError : null
          if (agentError !== null && agentError !== this.lastAgentErrorSeen) {
            this.lastAgentErrorSeen = agentError
            if (looksLikeQuotaText(agentError)) this.noteFailure('QUOTA')
          }
          this.publish()
        } catch (error) {
          this.fail('session-face', error)
        }
      }
      this.unbinding.push(face.subscribe(readFace))
      readFace()
    }
    const projections = face?.projections
    if (projections !== undefined && typeof projections.faceOf === 'function') {
      const pressure = projections.faceOf('contextPressure')
      const read = () => {
        try {
          this.applyPressure(pressure.getSnapshot())
        } catch (error) {
          this.fail('context-pressure', error)
        }
      }
      this.unbinding.push(pressure.subscribe(read))
      read()
    }
    const eventSource = binding.eventSource
    if (eventSource !== undefined && typeof eventSource.subscribe === 'function') {
      const read = () => {
        try {
          this.absorbWindow(eventSource.getSnapshot())
        } catch (error) {
          this.fail('session-events', error)
        }
      }
      this.unbinding.push(eventSource.subscribe(read))
      read()
    }
    this.publish()
  }

  subscribeWindow() {
    if (typeof window === 'undefined') return
    const onResize = () => {
      this.place(false)
      this.publish()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') this.pause()
      else {
        this.lastActivityAt = Date.now()
        this.loop()
      }
    }
    window.addEventListener('resize', onResize, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    this.disposers.push(() => {
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibility)
    })
  }

  subscribeMedia() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const read = () => {
      this.reduceMotion = query.matches || this.prefs.reduceMotion === true
      this.publish()
    }
    read()
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', read)
      this.disposers.push(() => query.removeEventListener('change', read))
    }
  }

  /* ---------------------------------------------------- 数据吸收 */

  applyPressure(pressure) {
    const occupancy = occupancyOf(pressure)
    const previous = this.level
    this.occupancy = occupancy
    this.level = fatigueLevel(occupancy === null ? null : occupancy.percent, previous)
    if (this.level > previous && this.level >= 2) {
      this.say(pick(this.t(this.level >= 4 ? 'line.level4' : this.level === 3 ? 'line.level3' : 'line.level2')))
    }
    this.publish()
  }

  absorbWindow(window_) {
    if (window_ === null || typeof window_ !== 'object') return
    const change = window_.change
    if (change === null || change === undefined) return
    let entries = []
    if (change.kind === 'append' || change.kind === 'prepend' || change.kind === 'replace') {
      entries = Array.isArray(change.entries) ? change.entries : []
    } else if (change.kind === 'settle-assistant') {
      entries = change.entry === undefined ? [] : [change.entry]
    }
    if (change.kind === 'replace' && entries.length > 40) entries = entries.slice(-40)
    for (const entry of entries) {
      if (entry !== null && typeof entry === 'object' && entry.type === 'event') this.absorbEvent(entry.event)
    }
  }

  absorbEvent(event) {
    if (event === null || typeof event !== 'object') return
    const type = event.type
    if (typeof type !== 'string') return
    if (typeof event.seq === 'number') {
      if (this.lastSeq !== null && event.seq <= this.lastSeq && type !== 'compaction/summary') return
      this.lastSeq = Math.max(this.lastSeq ?? 0, event.seq)
    }
    this.lastActivityAt = Date.now()
    if (type === 'compaction/summary') {
      this.triggerSweat(true)
      return
    }
    if (type === 'compaction/start') {
      this.say(this.t('line.sweat'))
      this.publish()
      return
    }
    if (type === 'turn/end') {
      const reason = event.data?.reason
      if (reason !== null && typeof reason === 'object' && reason.kind === 'error') {
        this.noteFailure(reason.error?.code)
        return
      }
      this.publish()
      return
    }
    if (type === 'assistant/message') {
      if (this.fault === 'quota') {
        this.fault = null
        this.triggerSweat(true)
        return
      }
      this.publish()
      return
    }
    if (type === 'step/start' || type === 'turn/start' || type === 'tool/call') this.publish()
  }

  /** 失败码 → 状态：quota 粘性（成功回复或点击后清除），throttle/auth 8 秒自清。 */
  noteFailure(code) {
    const kind = classifyTurnError(code)
    if (kind === null) return
    if (kind === 'quota') {
      if (this.fault !== 'quota') {
        this.fault = 'quota'
        this.say(this.t('line.quota'))
      }
      this.publish()
      return
    }
    if (kind === 'overflow') {
      this.triggerSweat(false)
      this.say(this.t('line.overflow'))
      return
    }
    this.fault = kind
    this.say(this.t(kind === 'throttle' ? 'line.throttle' : 'line.auth'))
    const expected = kind
    setTimeout(() => {
      if (this.fault === expected) {
        this.fault = null
        this.publish()
      }
    }, 8_000)
    this.publish()
  }

  clearFault() {
    if (this.fault === null) return
    this.fault = null
    this.publish()
  }

  triggerSweat(withLine) {
    this.sweatUntil = Date.now() + SWEAT_MS
    if (withLine) this.say(pick(this.t('line.sweat')))
    this.publish()
  }

  /* ---------------------------------------------------- 交互 */

  say(text) {
    // 气泡 id 用单调递增序号而不是 Date.now()：同一毫秒内连说两句时 id 会撞车，
    // 导致前后两句在 store 里被当成同一条（React key 也会重复）。
    this.bubbleSeq = (this.bubbleSeq ?? 0) + 1
    this.bubble = { text, id: this.bubbleSeq }
    this.bubbleUntil = Date.now() + BUBBLE_MS
    this.publish()
  }

  click() {
    const now = Date.now()
    if (this.fault === 'quota') {
      this.clearFault()
      return
    }
    if (now - this.lastLineAt > CLICK_LINE_COOLDOWN_MS) {
      this.lastLineAt = now
      this.say(pick(this.t('line.click')))
    }
    this.pop = 'sparkle'
    this.popUntil = now + 800
    this.publish()
  }

  doubleClick() {
    this.say(pick(this.t('line.dblclick')))
    this.pop = 'heart'
    this.popUntil = Date.now() + 1_200
    this.publish()
  }

  openMenu(x, y) {
    const width = 210
    const height = 280
    this.menuPosition = {
      x: clamp(x, 8, Math.max(8, window.innerWidth - width - 8)),
      y: clamp(y, 8, Math.max(8, window.innerHeight - height - 8)),
    }
    this.publish()
  }

  closeMenu() {
    if (this.menuPosition === null) return
    this.menuPosition = null
    this.publish()
  }

  wake() {
    this.lastActivityAt = Date.now()
    this.publish()
  }

  setPref(key, value) {
    this.prefs = { ...this.prefs, [key]: value }
    writePrefs(this.prefs)
    if (key === 'size') this.size = SIZE_CHOICES.includes(value) ? value : DEFAULT_SIZE
    if (key === 'lang') this.lang = value === 'zh' ? 'zh' : 'en'
    if (key === 'reduceMotion') this.reduceMotion = value === true
    if (key === 'size' || key === 'enabled') this.place(false)
    this.publish()
    if (typeof this.syncDebugHook === 'function') this.syncDebugHook()
  }

  place(reset) {
    if (typeof window === 'undefined') return
    const maxX = Math.max(8, window.innerWidth - this.size - 12)
    const maxY = Math.max(8, window.innerHeight - this.stageHeight() - 12)
    if (reset) {
      const fx = typeof this.prefs.fx === 'number' ? this.prefs.fx : 0.94
      const fy = typeof this.prefs.fy === 'number' ? this.prefs.fy : 0.84
      this.position = {
        x: clamp(Math.round(fx * window.innerWidth), 8, maxX),
        y: clamp(Math.round(fy * window.innerHeight), 8, maxY),
      }
      return
    }
    this.position = { x: clamp(this.position.x, 8, maxX), y: clamp(this.position.y, 8, maxY) }
  }

  moveTo(x, y) {
    if (typeof window === 'undefined') return
    const maxX = Math.max(8, window.innerWidth - this.size - 12)
    const maxY = Math.max(8, window.innerHeight - this.stageHeight() - 12)
    this.position = { x: clamp(Math.round(x), 8, maxX), y: clamp(Math.round(y), 8, maxY) }
    this.publish()
  }

  commitPosition() {
    if (typeof window === 'undefined' || window.innerWidth <= 0 || window.innerHeight <= 0) return
    this.prefs = { ...this.prefs, fx: this.position.x / window.innerWidth, fy: this.position.y / window.innerHeight }
    writePrefs(this.prefs)
  }

  setDragging(value) {
    if (this.dragging === value) return
    this.dragging = value
    this.publish()
  }

  /** 真的开始拖动（越过 4px 阈值）：说一句 + 进入"被拎起来"表现。每次拖拽只说一次。 */
  beginDrag() {
    this.dragging = true
    this.say(pick(this.t('line.drag')))
    this.publish()
  }

  /** 松手：说一句 + 记住新位置。 */
  endDrag() {
    this.dragging = false
    this.say(pick(this.t('line.drop')))
    this.commitPosition()
    this.publish()
  }

  /* ---------------------------------------------------- 状态推导 */

  mood() {
    const simulation = this.simulation ?? {}
    if (simulation.mood !== undefined) return simulation.mood
    if (Date.now() - this.lastActivityAt > IDLE_SLEEP_MS) return 'sleep'
    return this.running ? 'working' : 'idle'
  }

  eyeState() {
    // 自测可以强制指定任一眼睛状态（三种都不会被删掉，随时可调出来看/验收）。
    if (typeof this.simulation?.eye === 'string') return this.simulation.eye
    const level = this.simulation?.level ?? this.level
    // 只有眼睛能变时，用哪一帧必须跟"没变的嘴"协调：
    //   L4 / 打盹 → 'closed'（闭眼微笑：嘴角本来是开心的，配闭眼最自然）
    //   L2–L3    → 'half'（半闭 = 有点累但还在笑）
    // 'sleep'（困倦含泪）留在素材与自测里；等"整帧表情图"（poses/exhausted.png）到位，
    // 疲劳表现由整帧承担，就不再需要眼贴片去配一个不匹配的嘴。
    if (this.mood() === 'sleep' || level >= 4) return 'closed'
    if (level >= 2) return this.blinkPhase ? 'closed' : 'half'
    return this.blinkPhase ? 'half' : 'open'
  }

  /* ---------------------------------------------------- 计时循环 */

  loop() {
    if (this.stopped || this.raf !== 0) return
    const step = () => {
      this.raf = 0
      if (this.stopped) return
      try {
        this.tick()
      } catch (error) {
        this.fail('tick', error)
      }
      if (!this.stopped && document.visibilityState !== 'hidden') this.raf = requestAnimationFrame(step)
    }
    this.raf = requestAnimationFrame(step)
  }

  pause() {
    if (this.raf !== 0) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  tick() {
    const now = Date.now()
    if (!this.reduceMotion && !this.blinkPhase && now >= this.blinkAt) {
      this.blinkPhase = true
      this.publish()
      const interval = this.level >= 4 ? 9_000 : this.level >= 2 ? 6_500 : this.mood() === 'sleep' ? 12_000 : 4_200
      this.blinkAt = now + interval + Math.random() * interval
      setTimeout(() => {
        this.blinkPhase = false
        this.publish()
      }, BLINK_MS)
      return
    }
    const snapshot = this.store.getSnapshot()
    const expiredBubble = snapshot.bubble !== null && now >= this.bubbleUntil
    const expiredSweat = snapshot.sweat && now >= this.sweatUntil
    const expiredPop = snapshot.pop !== null && now >= this.popUntil
    const moodChanged = snapshot.mood !== this.mood()
    const visibilityChanged = snapshot.visible !== this.visibleNow()
    const wakeAt = this.lastActivityAt + IDLE_SLEEP_MS
    const sleepBoundary = Math.abs(now - wakeAt) < 600
    // 干活期间的"碎碎念"：按间隔补一句，且不在已有气泡时插话
    const workingChatter = this.running
      && now - this.lastWorkingLineAt > WORKING_LINE_INTERVAL_MS
      && now >= this.bubbleUntil
    if (workingChatter) {
      this.lastWorkingLineAt = now
      this.say(pick(this.t('line.working')))
    }
    if (expiredBubble || expiredSweat || expiredPop || moodChanged || visibilityChanged || sleepBoundary) this.publish()
  }

  /* ---------------------------------------------------- 自测钩子 */

  simulate(patch) {
    if (patch === null || patch === undefined) this.simulation = null
    else this.simulation = { ...(this.simulation ?? {}), ...patch }
    if (typeof patch?.bubble === 'string') {
      this.bubbleSeq = (this.bubbleSeq ?? 0) + 1
      this.bubble = { text: patch.bubble, id: this.bubbleSeq }
      this.bubbleUntil = Date.now() + BUBBLE_MS
    }
    this.publish()
  }

  fail(where, error) {
    console.warn(`[dsh-pet] ${where} failed`, error)
    if (this.warned) return
    this.warned = true
    this.error = `${where}: ${error?.message ?? String(error)}`
    this.publish()
  }
}

/* ------------------------------------------------------------------ SVG 道具 */

function svgNode(key, className, width, height, children, extra) {
  return React.createElement('svg', {
    key,
    className: `dsh-pet-prop ${className}`,
    viewBox: '0 0 24 24',
    width,
    height,
    'aria-hidden': 'true',
    style: extra,
  }, children)
}

const DROP_PATH = 'M12 2c3.2 5.4 7.4 9.2 7.4 13.1A7.4 7.4 0 0 1 4.6 15C4.6 11.2 8.8 7.4 12 2z'

function dropNode(key, className, size, style, delay) {
  return svgNode(key, className, size, size, [
    React.createElement('path', { key: 'drop', d: DROP_PATH, fill: '#8fd0ff', stroke: '#dff0ff', strokeWidth: 1 }),
  ], delay === undefined ? style : { ...style, animationDelay: delay })
}

/**
 * 道具节点（可能返回多个）。
 * 汗滴有两种玩法：被拎起来时是"连滴三颗"（小、带延迟、循环），擦汗时是原来的"甩出一颗"。
 */
function propNodes(kind, size, variant) {
  const px = Math.round(size * 0.24)
  if (kind === 'sweat') {
    if (variant === 'lift') {
      return [
        dropNode('sweat-0', 'dsh-pet-sweat-loop', Math.round(size * 0.105), { right: '3%', top: '9%' }, '0s'),
        dropNode('sweat-1', 'dsh-pet-sweat-loop', Math.round(size * 0.088), { right: '15%', top: '2%' }, '.4s'),
        dropNode('sweat-2', 'dsh-pet-sweat-loop', Math.round(size * 0.078), { left: '5%', top: '13%' }, '.8s'),
      ]
    }
    return [dropNode('sweat', 'dsh-pet-sweat', Math.round(size * 0.15), { right: '0%', top: '16%' })]
  }
  if (kind === 'zzz') {
    return [svgNode('zzz', 'dsh-pet-zzz', px, px, [
      React.createElement('text', { key: 'z1', x: 15, y: 10, fontSize: 11, fill: '#dbe6ff' }, 'Z'),
      React.createElement('text', { key: 'z2', x: 9, y: 16, fontSize: 8, fill: '#c3d3f5' }, 'z'),
      React.createElement('text', { key: 'z3', x: 4, y: 21, fontSize: 6, fill: '#adc0e8' }, 'z'),
    ], { right: '0%', top: '0%' })]
  }
  if (kind === 'heart') {
    return [svgNode('heart', 'dsh-pet-pop', px, px, [
      React.createElement('path', {
        key: 'heart',
        d: 'M12 21s-7.2-4.6-9.2-9.2A5.3 5.3 0 0 1 12 6.2a5.3 5.3 0 0 1 9.2 5.6C19.2 16.4 12 21 12 21z',
        fill: '#ff7c9c',
        stroke: '#ffd7e2',
        strokeWidth: 1,
      }),
    ], { left: '10%', top: '-4%' })]
  }
  if (kind === 'sparkle') {
    return [svgNode('sparkle', 'dsh-pet-pop', px, px, [
      React.createElement('path', {
        key: 'spark',
        d: 'M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9z',
        fill: '#ffe08a',
        stroke: '#fff6d8',
        strokeWidth: 1,
      }),
    ], { left: '4%', top: '0%' })]
  }
  if (kind === 'bowl') {
    return [svgNode('bowl', 'dsh-pet-bowl', Math.round(size * 0.44), Math.round(size * 0.28), [
      React.createElement('path', { key: 'body', d: 'M2 10.6h20a10 10 0 0 1-20 0z', fill: '#e9edf6', stroke: '#b9c3d8', strokeWidth: 1 }),
      React.createElement('ellipse', { key: 'rim', cx: 12, cy: 10.6, rx: 10, ry: 2.3, fill: '#cfd8ea', stroke: '#aab6cf', strokeWidth: 1 }),
      React.createElement('ellipse', { key: 'empty', cx: 12, cy: 10.6, rx: 7.2, ry: 1.2, fill: '#8d99b3' }),
      React.createElement('text', { key: 'zero', x: 12, y: 6.4, fontSize: 5, textAnchor: 'middle', fill: '#8ad1ff' }, '0'),
    ], { left: '28%', top: '56%' })]
  }
  if (kind === 'work') {
    return [svgNode('work', 'dsh-pet-work', px, Math.round(px * 0.5), [
      React.createElement('circle', { key: 'a', cx: 5, cy: 12, r: 2.4, fill: '#8ad1ff' }),
      React.createElement('circle', { key: 'b', cx: 12, cy: 12, r: 2.4, fill: '#b9e3ff' }),
      React.createElement('circle', { key: 'c', cx: 19, cy: 12, r: 2.4, fill: '#e3f4ff' }),
    ], { right: '0%', top: '24%' })]
  }
  return []
}

/* ------------------------------------------------------------------ React 组件 */

function eyeStyle(assets, eye) {
  const sprite = assets.sprite
  const box = eye.box
  return {
    left: `${(box[0] / sprite.width) * 100}%`,
    top: `${(box[1] / sprite.height) * 100}%`,
    width: `${(box[2] / sprite.width) * 100}%`,
    height: `${(box[3] / sprite.height) * 100}%`,
  }
}

function PetLayer(props) {
  const controller = props.controller
  const snapshot = React.useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot)
  const assets = controller.assets
  const drag = React.useRef(null)

  if (!snapshot.visible) return null

  const classes = ['dsh-pet-stage', `dsh-pet-${snapshot.mood}`]
  if (snapshot.level > 0) classes.push(`dsh-pet-l${snapshot.level}`)
  if (snapshot.dragging) classes.push('dsh-pet-dragging')
  const stageHeight = controller.stageHeight()
  const poseKey = poseFor(snapshot)
  const pose = assets.poses?.[poseKey] ?? null
  // 有整帧姿态时，体态由该帧表达 → 关闭程序化的塌肩/前倾
  if (pose !== null) classes.push('dsh-pet-haspose')

  const onPointerDown = (event) => {
    if (event.button !== 0) return
    controller.wake()
    controller.closeMenu()
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      left: controller.position.x,
      top: controller.position.y,
      moved: false,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const onPointerMove = (event) => {
    const start = drag.current
    if (start === null) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (!start.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    if (!start.moved) {
      start.moved = true
      controller.beginDrag()
    }
    controller.moveTo(start.left + dx, start.top + dy)
  }
  const onPointerUp = (event) => {
    const start = drag.current
    drag.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    if (start === null) return
    if (start.moved) {
      controller.endDrag()
    } else {
      controller.click()
    }
  }
  const onContextMenu = (event) => {
    event.preventDefault()
    event.stopPropagation()
    controller.wake()
    controller.openMenu(event.clientX, event.clientY)
  }
  const onKeyDown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      controller.openMenu(controller.position.x + snapshot.size / 2, controller.position.y)
      return
    }
    if (event.key === 'Escape') {
      controller.closeMenu()
      return
    }
    if (event.key.startsWith('Arrow')) {
      event.preventDefault()
      const step = 16
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
      controller.moveTo(controller.position.x + dx, controller.position.y + dy)
      controller.commitPosition()
    }
  }

  // 整帧姿态的高度按"该帧裁切高度 / 待机立绘高度"渲染：坐姿、塌肩这类本来就矮的帧
  // 会自然看起来更矮，而不是被强行拉到与站立同高（那会让坐姿显得偏大）。
  const poseStyle = pose === null ? undefined : { height: `${(pose.height / assets.sprite.height) * 100}%` }
  const baseChildren = [
    React.createElement('img', {
      key: `pose-${poseKey}`,
      className: 'dsh-pet-body',
      src: pose !== null ? pose.uri : assets.sprite.uri,
      alt: '',
      draggable: false,
      ...(poseStyle === undefined ? {} : { style: poseStyle }),
    }),
  ]
  const children = baseChildren
  // 眼态贴片只在“画面上就是待机立绘”时叠加：有手绘姿态时，表情已经由该姿态表达。
  const patches = pose === null && snapshot.eye !== 'open' ? assets.eyes[snapshot.eye] ?? null : null
  if (patches !== null) {
    patches.forEach((eye, index) => {
      children.push(React.createElement('img', {
        key: `eye-${index}`,
        className: 'dsh-pet-eye',
        src: eye.uri,
        alt: '',
        draggable: false,
        style: eyeStyle(assets, eye),
      }))
    })
  }
  const hasBowlPose = typeof assets.poses?.bowl?.uri === 'string'
  const prop = snapshot.quota === 'quota'
    ? (hasBowlPose ? null : 'bowl')
    : snapshot.sweat ? 'sweat'
      : snapshot.mood === 'sleep' ? 'zzz'
        : snapshot.mood === 'working' ? 'work'
          : snapshot.pop
  if (typeof prop === 'string') children.push(...propNodes(prop, snapshot.size, snapshot.dragging ? 'lift' : 'flick'))
  if (snapshot.bubble !== null) {
    children.push(React.createElement('div', { key: 'bubble', className: 'dsh-pet-bubble' }, snapshot.bubble.text))
  }
  if (snapshot.showMeter) {
    const percent = snapshot.occupancy === null || snapshot.occupancy === undefined ? null : snapshot.occupancy.percent
    const fill = percent === null ? 0 : percent
    const tone = fill >= 85 ? ' dsh-pet-hot' : fill >= 65 ? ' dsh-pet-warn' : ''
    children.push(React.createElement('div', { key: 'meter', className: 'dsh-pet-meter' }, [
      React.createElement('span', { key: 'value' }, percent === null ? controller.t('settings.unknown') : `${percent}%`),
      React.createElement('span', { key: 'bar', className: 'dsh-pet-meter-bar' },
        React.createElement('span', { className: `dsh-pet-meter-fill${tone}`, style: { width: `${fill}%` } })),
    ]))
  }

  return React.createElement('div', {
    className: `dsh-pet-root${snapshot.reduce ? ' dsh-pet-reduce' : ''}`,
    'data-dsh-pet': '1',
  },
  React.createElement('div', {
    className: classes.join(' '),
    style: { left: `${snapshot.x}px`, top: `${snapshot.y}px`, width: `${snapshot.size}px`, height: `${stageHeight}px` },
    role: 'button',
    tabIndex: 0,
    'aria-label': controller.t('stage.label'),
    'aria-haspopup': 'menu',
    title: controller.t('stage.label'),
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onDoubleClick: () => controller.doubleClick(),
    onContextMenu,
    onKeyDown,
  }, children),
  snapshot.menu === null ? null : React.createElement(PetMenu, { key: 'menu', controller, snapshot }))
}

function menuButton(key, label, onClick, hint) {
  const kids = [React.createElement('span', { key: 'label' }, label)]
  if (hint !== undefined) kids.push(React.createElement('span', { key: 'hint', className: 'dsh-pet-hint' }, hint))
  return React.createElement('button', { key, type: 'button', role: 'menuitem', onClick }, kids)
}

function PetMenu(props) {
  const controller = props.controller
  const snapshot = props.snapshot
  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') controller.closeMenu()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [controller])
  const hidden = Array.isArray(controller.prefs.hiddenSessions) ? controller.prefs.hiddenSessions : []
  const hiddenHere = controller.sessionId !== null && hidden.includes(controller.sessionId)
  const items = [React.createElement('div', { key: 'title', className: 'dsh-pet-menu-title' }, controller.t('menu.title'))]
  items.push(menuButton('hour', controller.t('menu.hideHour'), () => {
    controller.setPref('hiddenUntil', Date.now() + 3_600_000)
    controller.closeMenu()
  }))
  items.push(menuButton('session', controller.t(hiddenHere ? 'menu.showSession' : 'menu.hideSession'), () => {
    const next = new Set(hidden)
    if (hiddenHere) next.delete(controller.sessionId)
    else if (controller.sessionId !== null) next.add(controller.sessionId)
    controller.setPref('hiddenSessions', [...next])
    controller.closeMenu()
  }))
  items.push(React.createElement('hr', { key: 'hr1' }))
  SIZE_CHOICES.forEach((size) => {
    items.push(menuButton(`size-${size}`, `${controller.t('menu.size')} ${size}px`, () => {
      controller.setPref('size', size)
      controller.closeMenu()
    }, snapshot.size === size ? '✓' : undefined))
  })
  items.push(menuButton('meter', controller.t('menu.meter'), () => {
    controller.setPref('showMeter', controller.prefs.showMeter !== true)
    controller.closeMenu()
  }, snapshot.showMeter ? '✓' : undefined))
  items.push(menuButton('lang', controller.t('menu.lang'), () => {
    controller.setPref('lang', controller.lang === 'zh' ? 'en' : 'zh')
    controller.closeMenu()
  }, controller.lang))
  items.push(menuButton('reset', controller.t('menu.reset'), () => {
    controller.place(true)
    controller.commitPosition()
    controller.closeMenu()
  }))
  items.push(React.createElement('hr', { key: 'hr2' }))
  items.push(menuButton('dev', controller.t(snapshot.debug ? 'menu.devOff' : 'menu.dev'), () => {
    controller.setPref('debug', controller.prefs.debug !== true)
    controller.closeMenu()
  }, snapshot.debug ? '✓' : undefined))
  if (snapshot.debug) {
    items.push(menuButton('sim-quota', 'simulate QUOTA', () => {
      controller.simulate({ quota: 'quota', level: 1, sweat: false })
      controller.closeMenu()
    }))
    items.push(menuButton('sim-full', 'simulate 96%', () => {
      controller.simulate({ quota: null, level: 4, sweat: false, eye: null, occupancy: { percent: 96, usedTokens: 192_000, contextWindow: 200_000 } })
      controller.closeMenu()
    }))
    items.push(menuButton('sim-teary', 'simulate 困倦含泪 (sleep eyes)', () => {
      controller.simulate({ quota: null, level: 4, sweat: false, eye: 'sleep', bubble: controller.t('line.level4') })
      controller.closeMenu()
    }))
    items.push(menuButton('sim-sweat', 'simulate compact + wipe', () => {
      controller.simulate({
        quota: null,
        level: 0,
        occupancy: { percent: 17, usedTokens: 34_000, contextWindow: 200_000 },
        bubble: controller.t('line.sweat'),
      })
      controller.closeMenu()
    }))
    items.push(menuButton('sim-clear', 'clear simulation', () => {
      controller.simulate(null)
      controller.closeMenu()
    }))
  }
  items.push(menuButton('about', `${controller.t('menu.about')} v${VERSION}`, () => {
    controller.say(controller.t('about.body'))
    controller.closeMenu()
  }))
  return React.createElement('div', {
    className: 'dsh-pet-menu',
    role: 'menu',
    style: { left: `${snapshot.menu.x}px`, top: `${snapshot.menu.y}px` },
    onContextMenu: (event) => event.preventDefault(),
  }, items)
}

function SettingsRow(props) {
  const controller = props.controller
  const snapshot = React.useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot)
  const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '6px 0' }
  const row = (key, label, control) => React.createElement('div', { key, style: rowStyle }, [
    React.createElement('span', { key: 'label' }, label),
    control,
  ])
  const checkbox = (key, value, onChange) => React.createElement('input', {
    key,
    type: 'checkbox',
    checked: value === true,
    onChange: (event) => onChange(event.target.checked),
  })
  const usage = snapshot.occupancy === null || snapshot.occupancy === undefined
    ? controller.t('settings.unknown')
    : `${snapshot.occupancy.percent}% (${snapshot.occupancy.usedTokens}/${snapshot.occupancy.contextWindow})`
  const state = [
    `${controller.t('settings.state')}: ${controller.t(`settings.state.${snapshot.mood}`)}`,
    `${controller.t('settings.usage')}: ${usage}`,
    `${controller.t('settings.fatigue')}: L${snapshot.level}`,
    controller.t('settings.note'),
  ]
  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, [
    row('enabled', controller.t('settings.enabled'), checkbox('c-enabled', controller.prefs.enabled !== false, (value) => controller.setPref('enabled', value))),
    row('size', controller.t('settings.size'), React.createElement('select', {
      key: 'sel-size',
      value: String(snapshot.size),
      onChange: (event) => controller.setPref('size', Number(event.target.value)),
    }, SIZE_CHOICES.map((size) => React.createElement('option', { key: size, value: String(size) }, `${size}px`)))),
    row('meter', controller.t('settings.meter'), checkbox('c-meter', snapshot.showMeter, (value) => controller.setPref('showMeter', value))),
    row('reduce', controller.t('settings.reduce'), checkbox('c-reduce', controller.reduceMotion, (value) => controller.setPref('reduceMotion', value))),
    row('reset', controller.t('settings.reset'), React.createElement('button', {
      key: 'b-reset',
      type: 'button',
      onClick: () => {
        controller.place(true)
        controller.commitPosition()
      },
    }, controller.t('settings.reset'))),
    React.createElement('div', { key: 'state', style: { marginTop: '6px', opacity: 0.75, fontSize: '12px', lineHeight: 1.7 } },
      state.map((line, index) => React.createElement('div', { key: index }, line))),
  ])
}

/* ------------------------------------------------------------------ 插件入口 */

const inject = ['slots', 'sessions']

function styleNode(css) {
  const element = document.createElement('style')
  element.setAttribute('data-plugin', 'dsh-client-ui-pet')
  element.textContent = css
  document.head.append(element)
  return element
}

function apply(ctx) {
  const controller = new PetController(PET_ASSETS, {
    sessions: ctx.sessions,
    localeRegister: () => {
      try {
        if (typeof ctx.locale?.register === 'function') ctx.locale.register('pet', { zh: TEXT.zh, en: TEXT.en })
      } catch (error) {
        console.warn('[dsh-pet] locale registration skipped', error)
      }
    },
  })
  const Overlay = () => React.createElement(PetLayer, { controller })
  const Settings = () => React.createElement(SettingsRow, { controller })

  const style = styleNode(CSS)
  ctx.effect(() => () => {
    style.remove()
    controller.dispose()
  }, 'dsh-pet: style and controller')

  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-pet',
    order: 100,
    label: () => controller.t('stage.label'),
  }, Overlay)), 'dsh-pet: overlay entry')

  ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'dsh-pet',
    order: 60,
    label: () => controller.t('settings.title'),
  }, Settings)), 'dsh-pet: settings row')

  controller.start()

  // 开发者自测钩子：默认关闭，右键菜单「开发者自测」或 localStorage['dsh-pet:debug']='1' 启用。
  const enableDebug = () => {
    if (typeof window === 'undefined') return
    let forced = false
    try {
      forced = localStorage.getItem('dsh-pet:debug') === '1'
    } catch {
      forced = false
    }
    if (controller.prefs.debug !== true && !forced) {
      window.__dshPet = undefined
      return
    }
    window.__dshPet = {
      version: VERSION,
      simulate: (patch) => controller.simulate(patch),
      clear: () => controller.simulate(null),
      state: () => controller.store.getSnapshot(),
      controller,
    }
  }
  controller.syncDebugHook = enableDebug
  ctx.effect(() => {
    enableDebug()
    return () => {
      if (typeof window !== 'undefined') window.__dshPet = undefined
    }
  }, 'dsh-pet: debug hook')
}

exports.apply = apply
exports.inject = inject
exports.name = 'ui-pet'
exports.__test = {
  VERSION,
  occupancyOf,
  fatigueLevel,
  classifyTurnError,
  looksLikeQuotaText,
  poseFor,
  clamp,
  makeStore,
  PetController,
  TEXT,
  CSS,
  SIZE_CHOICES,
  LEVEL_THRESHOLDS,
  DEFAULT_SIZE,
  IDLE_SLEEP_MS,
}
