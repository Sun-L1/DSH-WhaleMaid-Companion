/**
 * 纯函数与产物契约测试（node --test）。
 * 运行：node --test plugin/tests
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BUNDLE_FILE, MANIFEST_FILE, loadBundle, classNameOf, flatten, textOf } from './harness.mjs'

const { exports: plugin, source } = loadBundle()
const { __test } = plugin

test('bundle registers exactly the package id and the plugin face', () => {
  const { id } = loadBundle()
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(id, pkg.name)
  assert.equal(plugin.name, 'ui-pet')
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots', 'sessions'])
  assert.ok(__test !== undefined)
})

test('bundle requires only the react baseline module', () => {
  const { requested } = loadBundle()
  assert.deepEqual([...new Set(requested)], ['react'])
})

test('bundle contains no network or injection surface', () => {
  const forbidden = [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /WebSocket/,
    /sendBeacon/,
    /\beval\s*\(/,
    /new\s+Function/,
    /\bimport\s*\(/,
    /https?:\/\//,
    /\.prompt\s*\(/,
    /ctx\.remote/,
  ]
  for (const pattern of forbidden) {
    assert.equal(pattern.test(source), false, `bundle matches forbidden pattern ${pattern}`)
  }
})

test('embedded assets are inline webp data URIs', () => {
  const dataUris = source.match(/data:image\/webp;base64,/g) ?? []
  assert.ok(dataUris.length >= 5, `expected several inline assets, found ${dataUris.length}`)
  assert.match(source, /"sprite":\s*\{/)
  assert.match(source, /"eyes":\s*\{/)
})

test('occupancyOf mirrors the shipped context-occupancy formula', () => {
  const { occupancyOf } = __test
  assert.deepEqual(occupancyOf({ projectedTokens: 50, pressureTokens: 40, contextWindow: 200 }), {
    percent: 25,
    usedTokens: 50,
    contextWindow: 200,
  })
  assert.equal(occupancyOf({ pressureTokens: 40, contextWindow: 200 }).percent, 20)
  assert.equal(occupancyOf({ projectedTokens: 250, contextWindow: 200 }).percent, 100)
  assert.equal(occupancyOf({ projectedTokens: 5 }), null)
  assert.equal(occupancyOf({ contextWindow: 0, projectedTokens: 5 }), null)
  assert.equal(occupancyOf(undefined), null)
  assert.equal(occupancyOf({}), null)
})

test('fatigueLevel uses bands 40/65/85/95 with downgrade hysteresis', () => {
  const { fatigueLevel } = __test
  assert.equal(fatigueLevel(0, 0), 0)
  assert.equal(fatigueLevel(39, 0), 0)
  assert.equal(fatigueLevel(40, 0), 1)
  assert.equal(fatigueLevel(64, 1), 1)
  assert.equal(fatigueLevel(65, 1), 2)
  assert.equal(fatigueLevel(85, 2), 3)
  assert.equal(fatigueLevel(95, 3), 4)
  // 迟滞：从 L2 掉到 62% 之前不降级
  assert.equal(fatigueLevel(63, 2), 2)
  assert.equal(fatigueLevel(61, 2), 1)
  // 从 L1 掉到 37% 之前不降级
  assert.equal(fatigueLevel(38, 1), 1)
  assert.equal(fatigueLevel(36, 1), 0)
  assert.equal(fatigueLevel(null, 3), 0)
  assert.equal(fatigueLevel(Number.NaN, 2), 0)
})

test('classifyTurnError only bowls for quota-class failures', () => {
  const { classifyTurnError } = __test
  assert.equal(classifyTurnError('QUOTA'), 'quota')
  assert.equal(classifyTurnError('HTTP_402'), 'quota')
  assert.equal(classifyTurnError('RATE_LIMIT'), 'throttle')
  assert.equal(classifyTurnError('HTTP_429'), 'throttle')
  assert.equal(classifyTurnError('CONTEXT_WINDOW_EXCEEDED'), 'overflow')
  assert.equal(classifyTurnError('AUTH'), 'auth')
  assert.equal(classifyTurnError('INVALID_CREDENTIAL'), 'auth')
  assert.equal(classifyTurnError('SERVER'), null)
  assert.equal(classifyTurnError(''), null)
  assert.equal(classifyTurnError(undefined), null)
})

test('looksLikeQuotaText recognizes provider and Chinese wording', () => {
  const { looksLikeQuotaText } = __test
  assert.equal(looksLikeQuotaText('OpenAI API error (429): insufficient_quota'), true)
  assert.equal(looksLikeQuotaText('Insufficient Balance'), true)
  assert.equal(looksLikeQuotaText('account balance depleted'), true)
  assert.equal(looksLikeQuotaText('quota exceeded'), true)
  assert.equal(looksLikeQuotaText('余额不足，请充值'), true)
  assert.equal(looksLikeQuotaText('rate limit exceeded, retry later'), false)
  assert.equal(looksLikeQuotaText(''), false)
  assert.equal(looksLikeQuotaText(undefined), false)
})

test('both locales define the same key set', () => {
  const zh = Object.keys(__test.TEXT.zh).sort()
  const en = Object.keys(__test.TEXT.en).sort()
  assert.deepEqual(zh, en)
  assert.ok(zh.includes('line.quota'))
  assert.ok(zh.includes('settings.note'))
})

test('every text key referenced by the source exists', () => {
  const keys = new Set(Object.keys(__test.TEXT.zh))
  const referenced = new Set()
  for (const match of source.matchAll(/controller\.t\(\s*'([^']+)'/g)) referenced.add(match[1])
  for (const match of source.matchAll(/this\.t\(\s*'([^']+)'/g)) referenced.add(match[1])
  for (const key of referenced) {
    if (key.includes('${')) continue
    assert.ok(keys.has(key), `missing text key: ${key}`)
  }
})

test('poseFor selects the mood pose, falling back to the idle sprite', () => {
  const { poseFor } = __test
  const base = { dragging: false, quota: null, sweat: false, level: 0, mood: 'idle' }
  assert.equal(poseFor(base), 'idle')
  assert.equal(poseFor({ ...base, mood: 'working' }), 'working')
  assert.equal(poseFor({ ...base, mood: 'sleep' }), 'sleep')
  assert.equal(poseFor({ ...base, level: 2 }), 'tired')
  assert.equal(poseFor({ ...base, level: 3 }), 'tired')
  assert.equal(poseFor({ ...base, level: 4 }), 'exhausted')
  assert.equal(poseFor({ ...base, sweat: true }), 'wipe')
  assert.equal(poseFor({ ...base, quota: 'quota' }), 'bowl')
  assert.equal(poseFor({ ...base, dragging: true, quota: 'quota' }), 'drag')
  // 优先级：quota > sweat > level
  assert.equal(poseFor({ ...base, level: 4, sweat: true, quota: 'quota', mood: 'sleep' }), 'bowl')
})

test('the manifest always ships an eye and pose inventory', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'))
  assert.ok(manifest.poses !== null && typeof manifest.poses === 'object')
  for (const state of ['half', 'closed', 'sleep']) {
    assert.equal(manifest.eyes[state].length, 2, `${state} must carry two eye patches`)
    for (const eye of manifest.eyes[state]) {
      assert.equal(eye.box.length, 4, 'eye boxes are [x, y, w, h] in sprite pixels')
      assert.ok(eye.box[2] > 0 && eye.box[3] > 0)
      assert.ok(eye.box[0] + eye.box[2] <= manifest.sprite.width, 'eye patch must fit the sprite')
      assert.ok(eye.box[1] + eye.box[3] <= manifest.sprite.height, 'eye patch must fit the sprite')
    }
  }
  for (const [name, pose] of Object.entries(manifest.poses)) {
    assert.ok(pose.uri.startsWith('data:image/webp;base64,'), `${name} pose must be inline webp`)
  }
})

test('the DOM tree carries the pet marker and no inline scripts', () => {
  const flat = flatten({ props: {} })
  assert.deepEqual(flat.length, 1)
  assert.equal(classNameOf({ props: { className: 'dsh-pet-stage dsh-pet-idle' } }).includes('dsh-pet-stage'), true)
  assert.equal(textOf({ props: { children: ['hi'] } }), 'hi')
  assert.equal(typeof BUNDLE_FILE, 'string')
})
