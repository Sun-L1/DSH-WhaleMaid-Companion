/**
 * 集成测试：用假 ctx 装配真实产物 plugin/lib/client.js（node:test）。
 * 运行：node tools/run_tests.mjs
 *
 * 覆盖的关键语义（素材组合不同，表现路径必须不同）：
 *   有 poses/<name>.png 整帧 → 用整帧；不叠眼贴片、不叠程序化空碗
 *   缺对应整帧            → 回落成 待机立绘 + 眼贴片 + 程序化 SVG 道具
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  loadBundle,
  createCtx,
  createSessions,
  createStorageStub,
  flatten,
  classNameOf,
  MANIFEST_FILE,
} from './harness.mjs'

const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'))

/** 启动一份插件实例；debug: true 时可用 window.__dshPet 拿到 controller（便于测回落路径）。 */
function boot({ debug = false, sessions } = {}) {
  const loaded = loadBundle({ localStorage: createStorageStub(debug ? { 'dsh-pet:debug': '1' } : {}) })
  const resolved = sessions === undefined ? createSessions() : sessions
  const cx = createCtx(resolved)
  loaded.exports.apply(cx.ctx)
  return { ...loaded, sessions: resolved, ...cx }
}

const overlayOf = (app) => app.registrations.find((entry) => entry.options.name === 'shell.overlay')
const render = (app) => flatten(overlayOf(app).Component())
const bodySrc = (flat) => flat.find((node) => classNameOf(node).includes('dsh-pet-body'))?.props.src
const stageClass = (flat) => classNameOf(flat.find((node) => classNameOf(node).includes('dsh-pet-stage')))
const eyes = (flat) => flat.filter((node) => classNameOf(node).includes('dsh-pet-eye'))

/** 临时摘掉整帧素材，验证回落路径。 */
function withoutPoses(app, run) {
  const controller = app.window.__dshPet.controller
  const saved = controller.assets.poses
  controller.assets.poses = {}
  controller.publish()
  try {
    run()
  } finally {
    controller.assets.poses = saved
    controller.publish()
  }
}

test('apply registers exactly the overlay entry, the settings row and the locale', () => {
  const app = boot()
  const ids = app.registrations.map((entry) => `${entry.options.name}#${entry.options.id}`).sort()
  assert.deepEqual(ids, ['settings.general.item#dsh-pet', 'shell.overlay#dsh-pet'])
  assert.deepEqual(app.injections, ['shell.overlay', 'settings.general.item'])
  assert.equal(app.localeRegistrations.length, 1)
  assert.equal(app.localeRegistrations[0].ns, 'pet')
})

test('the overlay renders the pet marker, the sprite and the stylesheet', () => {
  const app = boot()
  const flat = render(app)
  assert.ok(flat.some((node) => node.props?.['data-dsh-pet'] === '1'), 'missing data-dsh-pet root')
  assert.ok(bodySrc(flat).startsWith('data:image/webp;base64,'), 'base sprite is not the inline webp')
  assert.ok(stageClass(flat).includes('dsh-pet-idle'), 'expected the idle mood class')
  const style = app.dom.created.find((node) => node.attributes['data-plugin'] === 'dsh-client-ui-pet')
  assert.ok(style !== undefined, 'stylesheet was not injected')
})

test('fatigue uses the hand-authored pose frame, and falls back to eye patches without it', () => {
  const app = boot({ debug: true })
  app.sessions.__pressure.set({ projectedTokens: 68, contextWindow: 100 })
  let flat = render(app)
  assert.ok(stageClass(flat).includes('dsh-pet-l2'), `expected L2, got ${stageClass(flat)}`)
  assert.ok(stageClass(flat).includes('dsh-pet-haspose'), 'a pose frame must mark the stage')
  assert.equal(bodySrc(flat), manifest.poses.tired.uri, 'L2 must render the tired pose frame')
  assert.equal(eyes(flat).length, 0, 'a pose frame carries the expression; no eye patches on top')

  withoutPoses(app, () => {
    const fallback = render(app)
    assert.equal(bodySrc(fallback), manifest.sprite.uri, 'without a pose frame the idle sprite returns')
    assert.equal(eyes(fallback).length, 2, 'without a pose frame the eye patches must come back')
    assert.ok(stageClass(fallback).includes('dsh-pet-l2'))
    assert.equal(stageClass(fallback).includes('dsh-pet-haspose'), false)
  })
})

test('compaction triggers the sweat wipe and resets fatigue', () => {
  const app = boot()
  app.sessions.__pressure.set({ projectedTokens: 95, contextWindow: 100 })
  assert.ok(stageClass(render(app)).includes('dsh-pet-l4'))
  const event = { type: 'compaction/summary', seq: 10, data: { compactionId: 'c1', shadowedTokenCount: 9000 } }
  app.sessions.__events.set({
    entries: [{ type: 'event', event }],
    hasMore: false,
    revision: 1,
    change: { kind: 'append', entries: [{ type: 'event', event }] },
  })
  app.sessions.__pressure.set({ projectedTokens: 12, contextWindow: 100 })
  const flat = render(app)
  assert.ok(flat.some((node) => classNameOf(node).includes('dsh-pet-sweat')), 'expected the sweat prop')
  assert.ok(flat.some((node) => classNameOf(node).includes('dsh-pet-bubble')), 'expected a wipe bubble')
  assert.equal(/dsh-pet-l[1-4]/.test(stageClass(flat)), false, 'fatigue must reset after compaction')
})

test('QUOTA bowls only for quota-class failures, and recovery clears it', () => {
  const app = boot({ debug: true })
  const push = (event, seq) => app.sessions.__events.set({
    entries: [{ type: 'event', event }],
    hasMore: false,
    revision: seq,
    change: { kind: 'append', entries: [{ type: 'event', event }] },
  })
  push({ type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } } }, 1)
  let flat = render(app)
  assert.notEqual(bodySrc(flat), manifest.poses.bowl.uri, 'RATE_LIMIT must not raise the bowl')

  push({ type: 'turn/end', seq: 2, data: { turn: 2, reason: { kind: 'error', error: { code: 'QUOTA' } } } }, 2)
  flat = render(app)
  assert.equal(bodySrc(flat), manifest.poses.bowl.uri, 'QUOTA must render the empty-bowl pose frame')
  assert.ok(stageClass(flat).includes('dsh-pet-quota'), 'quota mood class missing')
  assert.equal(flat.some((node) => classNameOf(node).includes('dsh-pet-bowl')), false, 'the pose frame already carries the bowl')

  withoutPoses(app, () => {
    const fallback = render(app)
    assert.ok(fallback.some((node) => classNameOf(node).includes('dsh-pet-bowl')), 'without the bowl pose the SVG bowl must appear')
  })

  push({ type: 'assistant/message', seq: 3, data: { turn: 3, step: 1, message: { role: 'assistant', content: [] } } }, 3)
  flat = render(app)
  assert.notEqual(bodySrc(flat), manifest.poses.bowl.uri, 'a successful reply must clear the bowl')
})

test('session promptError QUOTA and Chinese lastAgentError both bowl', () => {
  const app = boot()
  app.sessions.__face.set({ running: false, promptError: { error: { code: 'QUOTA', message: 'Insufficient Balance' } }, lastAgentError: null })
  assert.equal(bodySrc(render(app)), manifest.poses.bowl.uri)
  app.sessions.__face.set({ running: false, promptError: null, lastAgentError: '请求失败：余额不足' })
  assert.equal(bodySrc(render(app)), manifest.poses.bowl.uri)
})

test('working prefers its pose frame, and falls back to the idle sprite plus work dots without it', () => {
  const app = boot({ debug: true })
  app.sessions.__face.set({ running: true, promptError: null, lastAgentError: null })
  let flat = render(app)
  assert.ok(stageClass(flat).includes('dsh-pet-working'))
  assert.equal(bodySrc(flat), manifest.poses.working.uri, 'running must render the working pose frame')
  assert.equal(eyes(flat).length, 0, 'the pose frame carries the expression')

  // 各帧按自己的相对高度渲染：坐姿（裁切更矮）不能被拉到与站立同高
  const body = flat.find((node) => classNameOf(node).includes('dsh-pet-body'))
  const ratio = manifest.poses.working.height / manifest.sprite.height
  assert.equal(body.props.style.height, `${ratio * 100}%`, 'the pose must render at its own relative height')
  assert.notEqual(ratio, 1, 'this fixture expects the working pose to be shorter than the idle sprite')

  withoutPoses(app, () => {
    const fallback = render(app)
    assert.equal(bodySrc(fallback), manifest.sprite.uri)
    assert.ok(fallback.some((node) => classNameOf(node).includes('dsh-pet-work')), 'expected the working dots prop')
    assert.equal(fallback.find((node) => classNameOf(node).includes('dsh-pet-body')).props.style, undefined,
      'the base sprite must fill the stage')
  })
})

test('dragging prefers the drag pose frame', () => {
  const app = boot({ debug: true })
  const controller = app.window.__dshPet.controller
  controller.setDragging(true)
  const flat = render(app)
  assert.ok(stageClass(flat).includes('dsh-pet-dragging'))
  assert.equal(bodySrc(flat), manifest.poses.drag.uri, 'dragging must render the dangling pose frame')
})

test('dragging talks, sweats, and dropping commits the new position with a line', () => {
  const app = boot({ debug: true })
  const controller = app.window.__dshPet.controller
  const bubbles = new Map()
  controller.store.subscribe(() => {
    const bubble = controller.store.getSnapshot().bubble
    if (bubble !== null) bubbles.set(bubble.id, bubble.text)
  })

  controller.beginDrag()
  let flat = render(app)
  assert.ok(stageClass(flat).includes('dsh-pet-dragging'))
  const liftDrops = flat.filter((node) => classNameOf(node).includes('dsh-pet-sweat'))
  assert.equal(liftDrops.length, 3, 'being lifted must drip three small drops')
  assert.ok(liftDrops.every((drop) => classNameOf(drop).includes('dsh-pet-sweat-loop')), 'lift drops loop')
  assert.ok(liftDrops.every((drop) => drop.props.width <= Math.round(190 * 0.11)), `lift drops must be small, got ${liftDrops.map((d) => d.props.width).join('/')}`)
  assert.equal(new Set(liftDrops.map((drop) => drop.props.style.animationDelay)).size, 3, 'the three drops are staggered')
  assert.ok(flat.some((node) => classNameOf(node).includes('dsh-pet-bubble')), 'dragging must raise a speech bubble')
  assert.equal(bubbles.size, 1, 'exactly one line when the drag starts')

  controller.moveTo(200, 200)
  controller.endDrag()
  flat = render(app)
  assert.equal(stageClass(flat).includes('dsh-pet-dragging'), false, 'dragging must end on drop')
  assert.equal(flat.some((node) => classNameOf(node).includes('dsh-pet-sweat')), false, 'the lift sweat must stop')
  assert.equal(bubbles.size, 2, 'one more line when dropped')
  assert.equal(controller.prefs.fx !== undefined && controller.prefs.fy !== undefined, true,
    'the dropped position must be persisted as a viewport fraction')
  const [first, second] = [...bubbles.values()]
  assert.notEqual(first, second, 'drag and drop use different lines')
})

test('starting and finishing a run talk, and repeated updates do not spam', () => {
  const app = boot({ debug: true })
  const controller = app.window.__dshPet.controller
  const bubbles = new Map()
  controller.store.subscribe(() => {
    const bubble = controller.store.getSnapshot().bubble
    if (bubble !== null) bubbles.set(bubble.id, bubble.text)
  })
  const workingLines = new Set([...Object.values(controller.t('line.working'))])
  const doneLines = new Set([...Object.values(controller.t('line.done'))])

  app.sessions.__face.set({ running: true, promptError: null, lastAgentError: null })
  assert.equal(bubbles.size, 1, 'starting a run must say one line')
  assert.ok(workingLines.has([...bubbles.values()][0]), 'that line must be a working line')

  // 同一个 running=true 的重复推送不能再冒泡（防刷屏）
  app.sessions.__face.set({ running: true, promptError: null, lastAgentError: null })
  controller.publish()
  assert.equal(bubbles.size, 1, 'repeated running updates must not repeat the line')

  app.sessions.__face.set({ running: false, promptError: null, lastAgentError: null })
  assert.equal(bubbles.size, 2, 'finishing a run must say one line')
  assert.ok(doneLines.has([...bubbles.values()][1]), 'that line must be a completion line')
  const flat = render(app)
  assert.ok(flat.some((node) => classNameOf(node).includes('dsh-pet-pop')), 'finishing pops a sparkle')
})

test('switching the current session rebinds without leaking subscriptions', () => {
  const app = boot()
  const before = app.sessions.__bindings.length
  app.sessions.__list.set({ current: 'session-2' })
  assert.ok(app.sessions.__bindings.length > before, 'binding() was not called for the new session')
  assert.equal(app.sessions.__list.listenerCount(), 1, 'list subscription leaked')
})

test('dispose removes registrations, the stylesheet and every subscription', () => {
  const app = boot()
  assert.equal(app.registrations.length, 2)
  app.ctx.disposeAll()
  assert.equal(app.registrations.length, 0, 'slot registrations were not disposed')
  const style = app.dom.created.find((node) => node.attributes['data-plugin'] === 'dsh-client-ui-pet')
  assert.equal(style.removed, true, 'stylesheet was not removed')
  assert.equal(app.sessions.__list.listenerCount(), 0, 'session subscriptions leaked')
  assert.equal(app.window.__dshPet, undefined)
})

test('the plugin survives a host without sessions, bindings or projections', () => {
  const bare = loadBundle()
  const cx = createCtx(undefined)
  assert.doesNotThrow(() => bare.exports.apply(cx.ctx))
  assert.equal(cx.registrations.length, 2)

  const sessions = createSessions()
  sessions.binding = () => undefined
  const second = loadBundle()
  const cx2 = createCtx(sessions)
  assert.doesNotThrow(() => second.exports.apply(cx2.ctx))

  const partial = createSessions()
  const original = partial.binding.bind(partial)
  partial.binding = (id) => {
    const binding = original(id)
    return binding === undefined ? undefined : { session: binding.session }
  }
  const third = loadBundle()
  const cx3 = createCtx(partial)
  assert.doesNotThrow(() => third.exports.apply(cx3.ctx))

  cx.ctx.disposeAll()
  cx2.ctx.disposeAll()
  cx3.ctx.disposeAll()
})

test('malformed event windows and events never throw', () => {
  const app = boot()
  const shapes = [
    undefined,
    null,
    {},
    { change: null },
    { change: { kind: 'append', entries: [null, 42, { type: 'event' }, { type: 'transient', event: {} }] } },
    { change: { kind: 'settle-assistant', entry: { type: 'event', event: { type: 'turn/end', data: null } } } },
    { change: { kind: 'replace', entries: [{ type: 'event', event: { type: 'turn/end', seq: 1, data: { reason: { kind: 'error' } } } }] } },
  ]
  for (const shape of shapes) {
    assert.doesNotThrow(() => app.sessions.__events.set(shape))
    assert.doesNotThrow(() => render(app))
  }
})

test('the debug hook drives every documented state, and can still force the teary eye state', () => {
  const app = boot({ debug: true })
  assert.equal(typeof app.window.__dshPet?.simulate, 'function', 'debug hook missing under dsh-pet:debug=1')

  app.window.__dshPet.simulate({ level: 4, quota: null, sweat: false, eye: null, occupancy: { percent: 96, usedTokens: 192_000, contextWindow: 200_000 } })
  let flat = render(app)
  assert.ok(stageClass(flat).includes('dsh-pet-l4'))
  assert.equal(bodySrc(flat), manifest.poses.exhausted.uri, 'L4 must render the exhausted pose frame')

  // 三种眼态都保留：强制指定 + 无整帧（level 1 = idle，没有 idle 整帧）→ 眼贴片生效
  app.window.__dshPet.simulate({ level: 1, quota: null, sweat: false, eye: 'sleep' })
  flat = render(app)
  assert.deepEqual(eyes(flat).map((eye) => eye.props.src), manifest.eyes.sleep.map((eye) => eye.uri),
    'the teary eye state must remain reachable (nothing was deleted)')

  app.window.__dshPet.clear()
  flat = render(app)
  assert.equal(bodySrc(flat), manifest.sprite.uri)
})

test('preferences round-trip through localStorage, including the context meter', () => {
  const storage = createStorageStub()
  const app = boot({ sessions: undefined })
  app.ctx.disposeAll()
  const fresh = loadBundle({ localStorage: storage })
  const cx = createCtx(createSessions())
  fresh.exports.apply(cx.ctx)
  const settings = cx.registrations.find((entry) => entry.options.name === 'settings.general.item')
  const flat = flatten(settings.Component())
  assert.equal(flat.filter((node) => node.type === 'input' && node.props?.type === 'checkbox').length, 3)
  assert.equal(flat.filter((node) => node.type === 'select').length, 1)
  assert.equal(flat.filter((node) => node.type === 'button').length, 1)
  assert.equal(storage.getItem('dsh-pet:v1'), null, 'nothing should be persisted before the user changes a preference')
  cx.ctx.disposeAll()
})
