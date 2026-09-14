#!/usr/bin/env node
/**
 * DSH Copilot pet — 产物硬门禁。
 *
 * 这是安装前的最后一道自动检查，覆盖三件事：
 *  1) DSH 客户端插件契约（package.json / dsh.client / dsh.bundle.patch / exports ./client）
 *  2) 安全边界：产物必须是纯脚本、只 require('react')、零网络与零注入 API
 *  3) 素材完整性：data URI 可解码、WebP 尺寸与清单一致、源图哈希可追溯
 *
 * 用法：node tools/verify_plugin.mjs [--quiet]
 * 退出码：0 = 全绿；1 = 有检查项失败。
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = join(ROOT, 'plugin')
const quiet = process.argv.includes('--quiet')

const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** 读 WebP 画布尺寸（支持 VP8X / VP8 / VP8L 三种头）。 */
function webpSize(buffer) {
  assert(buffer.length > 30, 'webp payload too short')
  assert(buffer.toString('ascii', 0, 4) === 'RIFF', 'not a RIFF container')
  assert(buffer.toString('ascii', 8, 12) === 'WEBP', 'not a WEBP container')
  const fourcc = buffer.toString('ascii', 12, 16)
  if (fourcc === 'VP8X') {
    const width = 1 + (buffer.readUIntLE(24, 3))
    const height = 1 + (buffer.readUIntLE(27, 3))
    return { width, height, format: 'VP8X' }
  }
  if (fourcc === 'VP8 ') {
    // 3-byte start code 0x9d 0x01 0x2a, then two 14-bit dimension fields.
    assert(buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a, 'unexpected VP8 sync code')
    const width = buffer.readUInt16LE(26) & 0x3fff
    const height = buffer.readUInt16LE(28) & 0x3fff
    return { width, height, format: 'VP8' }
  }
  if (fourcc === 'VP8L') {
    const bits = buffer.readUInt32LE(21)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >> 14) & 0x3fff) + 1
    return { width, height, format: 'VP8L' }
  }
  throw new Error(`unsupported WEBP chunk ${fourcc}`)
}

function decodeDataUri(uri, label) {
  assert(typeof uri === 'string' && uri.startsWith('data:image/webp;base64,'), `${label}: not an inline webp data URI`)
  const payload = Buffer.from(uri.slice('data:image/webp;base64,'.length), 'base64')
  assert(payload.length > 0, `${label}: empty payload`)
  webpSize(payload)
  return payload
}

/* --------------------------------------------------------------- 载入输入 */

const pkgRaw = readFileSync(join(PLUGIN, 'package.json'), 'utf8')
const pkg = JSON.parse(pkgRaw)
const manifestRaw = readFileSync(join(PLUGIN, 'src', 'assets.gen.json'), 'utf8')
const manifest = JSON.parse(manifestRaw)
const bundle = existsSync(join(PLUGIN, 'lib', 'client.js')) ? readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8') : ''
const nodeHalf = existsSync(join(PLUGIN, 'lib', 'index.js')) ? readFileSync(join(PLUGIN, 'lib', 'index.js'), 'utf8') : ''

/* --------------------------------------------------------------- 1) 契约 */

check('package.json declares dsh.client platform web with a ./client export', () => {
  assert(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform must be "web"')
  assert(typeof pkg.exports?.['./client'] === 'string', 'exports["./client"] is required by the scanner')
  assert(pkg.main === 'lib/index.js' || typeof pkg.exports?.['.'] === 'string', 'missing main / exports["."]')
  return `${pkg.name}@${pkg.version}`
})

check('package.json declares dsh.bundle.patch and the file exists', () => {
  const patch = pkg.dsh?.bundle?.patch
  assert(typeof patch === 'string' && patch !== '', 'dsh.bundle.patch is required for bundle-layer installs')
  assert(existsSync(join(PLUGIN, patch)), `missing patch file ${patch}`)
  const body = readFileSync(join(PLUGIN, patch), 'utf8')
  assert(body.includes('id: ui-pet'), 'patch does not insert the ui-pet row')
  assert(body.includes(pkg.name), 'patch does not name this package')
  return patch
})

check('package.json ships no runtime dependencies and no lifecycle scripts', () => {
  const deps = pkg.dependencies ?? {}
  assert(Object.keys(deps).length === 0, `runtime dependencies must stay empty, found ${Object.keys(deps).join(', ')}`)
  const scripts = Object.keys(pkg.scripts ?? {})
  assert(!scripts.includes('postinstall') && !scripts.includes('prepare'), 'lifecycle scripts are not allowed')
  assert(Object.keys(pkg.peerDependencies ?? {}).length >= 1, 'peerDependencies expected for @deepseek-ai/cordis / react')
  return `${Object.keys(pkg.peerDependencies).join(', ')}`
})

check('files whitelist covers the shipped runtime files', () => {
  const files = pkg.files ?? []
  for (const required of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']) {
    assert(files.includes(required), `files[] must include ${required}`)
  }
  return files.join(', ')
})

/* --------------------------------------------------------------- 2) 产物与安全 */

check('both halves parse and load, and the bundle envelope is exact', async () => {
  assert(nodeHalf !== '', 'plugin/lib/index.js missing — run node tools/build_bundle.mjs')
  assert(bundle !== '', 'plugin/lib/client.js missing — run node tools/build_bundle.mjs')
  // Node 半边是 ESM：真导入一次（同时证明它没有副作用、没有 inject）。
  const half = await import(pathToFileURL(join(PLUGIN, 'lib', 'index.js')).href)
  assert(half.name === 'ui-pet', `Node half name must be "ui-pet", got ${String(half.name)}`)
  assert(typeof half.apply === 'function', 'Node half must export apply()')
  assert(half.inject === undefined, 'Node half must not declare inject')
  // 浏览器半边是经典脚本：用 vm.Script 只做语法检查（不执行）。
  new vm.Script(bundle, { filename: 'lib/client.js' })
  const loads = bundle.match(/window\.__ModuleLoader__\.load\(/g) ?? []
  assert(loads.length === 1, `expected exactly one __ModuleLoader__.load call, found ${loads.length}`)
  assert(bundle.includes(`id: ${JSON.stringify(pkg.name)}`), 'bundle id must equal the package name')
  assert(/factory:\s*\(require\)/.test(bundle), 'bundle factory must take require')
  assert(/exports\.apply\s*=/.test(bundle), 'bundle must export apply')
  assert(/exports\.inject\s*=/.test(bundle), 'bundle must export inject')
  return `${Buffer.byteLength(bundle)} bytes`
})

check('the bundle requires only the react baseline module', () => {
  const requested = [...bundle.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1])
  const unique = [...new Set(requested)]
  assert(unique.length === 1 && unique[0] === 'react', `unexpected requires: ${unique.join(', ') || '(none)'}`)
  return unique.join(', ')
})

check('no network, no dynamic code, no prompt injection surface', () => {
  const forbidden = [
    [/\bfetch\s*\(/, 'fetch()'],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
    [/\bWebSocket\b/, 'WebSocket'],
    [/\bsendBeacon\b/, 'sendBeacon'],
    [/\beval\s*\(/, 'eval()'],
    [/\bnew\s+Function\b/, 'new Function'],
    [/\bimport\s*\(/, 'dynamic import'],
    [/https?:\/\//, 'absolute URL'],
    [/\.prompt\s*\(/, 'session.prompt()'],
    [/ctx\.remote\b/, 'ctx.remote'],
    [/document\.cookie/, 'document.cookie'],
    [/localStorage\.clear\s*\(/, 'localStorage.clear()'],
    [/document\.body\.(append|prepend)/, 'document.body injection'],
  ]
  const hits = forbidden.filter(([pattern]) => pattern.test(bundle)).map(([, label]) => label)
  assert(hits.length === 0, `bundle contains: ${hits.join(', ')}`)
  return `${forbidden.length} patterns clean`
})

check('the Node half is inert (no services injected, no side effects)', () => {
  assert(!/\binject\s*=/.test(nodeHalf), 'the Node half must not declare inject')
  const forbidden = [/\bfetch\s*\(/, /\brequire\s*\(/, /\bimport\s*\(/, /node:fs/, /child_process/]
  const hits = forbidden.filter((pattern) => pattern.test(nodeHalf))
  assert(hits.length === 0, 'the Node half must not touch io')
  return 'empty apply()'
})

/* --------------------------------------------------------------- 3) 素材 */

check('assets.gen.json traces back to the source images', () => {
  const sourceFile = join(ROOT, manifest.source.path)
  assert(existsSync(sourceFile), `missing ${manifest.source.path}`)
  const digest = sha256(readFileSync(sourceFile))
  assert(digest === manifest.source.sha256, `cut source hash mismatch: ${digest} != ${manifest.source.sha256}`)
  const provenance = manifest.provenance ?? {}
  if (provenance.path !== undefined) {
    const original = join(ROOT, provenance.path)
    assert(existsSync(original), `missing ${provenance.path}`)
    const originalDigest = sha256(readFileSync(original))
    assert(originalDigest === provenance.sha256, `original hash mismatch: ${originalDigest} != ${provenance.sha256}`)
  }
  const background = manifest.source.background
  assert(Array.isArray(background) && background.length === 3, 'manifest must record the detected plate colour')
  return `${manifest.source.path} (bg ${background.join(',')}) + ${provenance.path ?? 'no provenance'}`
})

check('every inline asset decodes and matches its recorded hash and size', () => {
  const entries = [['sprite', manifest.sprite]]
  for (const [state, eyes] of Object.entries(manifest.eyes)) {
    eyes.forEach((eye, index) => entries.push([`eyes.${state}[${index}]`, eye]))
  }
  entries.push(['avatar', manifest.avatar])
  for (const [name, pose] of Object.entries(manifest.poses ?? {})) entries.push([`poses.${name}`, pose])
  for (const [label, entry] of entries) {
    const payload = decodeDataUri(entry.uri, label)
    assert(sha256(payload) === entry.sha256, `${label}: sha256 mismatch`)
    if (entry.width !== undefined) {
      const size = webpSize(payload)
      assert(size.width === entry.width && size.height === entry.height,
        `${label}: decoded ${size.width}x${size.height} != declared ${entry.width}x${entry.height}`)
    }
  }
  return `${entries.length} inline assets`
})

check('the bundle embeds exactly the manifest that is on disk', () => {
  const match = /const PET_ASSETS = (\{[\s\S]*?\});\n/.exec(bundle)
  assert(match !== null, 'could not locate PET_ASSETS in the bundle')
  const embedded = JSON.parse(match[1])
  assert(JSON.stringify(embedded) === JSON.stringify(manifest), 'bundle assets drifted from plugin/src/assets.gen.json — rebuild')
  assert(embedded.poses !== null && typeof embedded.poses === 'object', 'manifest must always carry a poses map (possibly empty)')
  return `sprite ${embedded.sprite.width}x${embedded.sprite.height}, ${Object.keys(embedded.poses).length} hand-authored pose(s)`
})

check('eye patches align inside the sprite canvas', () => {
  for (const [state, eyes] of Object.entries(manifest.eyes)) {
    assert(eyes.length === 2, `${state}: expected two eye patches`)
    for (const eye of eyes) {
      const [x, y, w, h] = eye.box
      assert(x >= 0 && y >= 0 && w > 0 && h > 0, `${state}: malformed box ${JSON.stringify(eye.box)}`)
      assert(x + w <= manifest.sprite.width, `${state}: patch exceeds sprite width`)
      assert(y + h <= manifest.sprite.height, `${state}: patch exceeds sprite height`)
    }
  }
  return 'half / closed / sleep × 2 eyes'
})

/* --------------------------------------------------------------- 输出 */

const results = []
for (const entry of checks) {
  try {
    const detail = await entry.fn()
    results.push({ name: entry.name, ok: true, detail: detail ?? '' })
  } catch (error) {
    results.push({ name: entry.name, ok: false, detail: error?.message ?? String(error) })
  }
}

const failed = results.filter((entry) => !entry.ok)
if (!quiet || failed.length > 0) {
  const width = Math.max(...results.map((entry) => entry.name.length))
  for (const entry of results) {
    const mark = entry.ok ? 'PASS' : 'FAIL'
    const line = `${mark}  ${entry.name.padEnd(width)}  ${entry.detail}`
    if (!entry.ok) console.error(line)
    else if (!quiet) console.log(line)
  }
}
console.log(`verify: ${results.length - failed.length}/${results.length} checks passed`)
process.exitCode = failed.length === 0 ? 0 : 1
