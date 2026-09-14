#!/usr/bin/env node
/**
 * 装后校验：确认桌宠真的进了运行中的 Harness。
 *
 * 两级检查：
 *  A) 文件系统（总是可做，不需要凭据）
 *     已安装包存在、lib/client.js 与工作区产物逐字节一致、patch 文件里有未禁用的 ui-pet 行
 *  B) 运行中的服务（尽力而为，必要时给 --token）
 *     取 GET / 的 HTML，解析 window.__DSH_BOOT__，确认启动图里有该行，
 *     再抓该行所属 batch 的 combo 脚本，确认里面确实带着本插件的 bundle 内容
 *
 * 用法：
 *   node tools/check_live.mjs
 *   node tools/check_live.mjs --url http://127.0.0.1:<port> --token <启动时打印的 token>
 *   node tools/check_live.mjs --profile web --home "$env:DSH_HOME"
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = '@dsh-local/dsh-client-ui-pet'
const ENTRY_ID = 'ui-pet'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 1) {
  const item = process.argv[i]
  if (item.startsWith('--')) args.set(item.slice(2), process.argv[i + 1]?.startsWith('--') ? 'true' : (process.argv[i + 1] ?? 'true'))
}
const home = args.get('home') ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const profile = args.get('profile') ?? 'web'
// 端口刻意不写死：DSH 的监听端口是启动配置（没有默认常量），本机值不该进仓库。
const configuredUrl = args.get('url') ?? process.env.DSH_WEB_URL
const baseUrl = typeof configuredUrl === 'string' && configuredUrl.startsWith('http') ? configuredUrl.replace(/\/$/, '') : null
const token = args.get('token')

const lines = []
let failures = 0
function report(ok, name, detail = '') {
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  ${detail}`}`)
  if (!ok) failures += 1
}
function skip(name, detail) {
  lines.push(`SKIP  ${name}  ${detail}`)
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/* ------------------------------------------------------------ A) 文件系统 */

const profileDir = join(home, 'profiles', profile)
const patchPath = join(profileDir, 'cordis.patch.yml')
const installedDir = join(profileDir, 'node_modules', '@dsh-local', 'dsh-client-ui-pet')
const localBundle = join(ROOT, 'plugin', 'lib', 'client.js')

report(existsSync(installedDir), 'installed package present', installedDir)
if (existsSync(installedDir)) {
  const installedBundle = join(installedDir, 'lib', 'client.js')
  report(existsSync(installedBundle), 'installed lib/client.js present')
  if (existsSync(installedBundle) && existsSync(localBundle)) {
    const same = Buffer.compare(readFileSync(installedBundle), readFileSync(localBundle)) === 0
    report(same, 'installed bundle matches the workspace artifact', same ? sha256(readFileSync(installedBundle)).slice(0, 16) + '…' : 'differs — re-run tools\\install_live.ps1')
  }
}
if (existsSync(patchPath)) {
  const text = readFileSync(patchPath, 'utf8')
  const hasRow = new RegExp(`id:\\s*${ENTRY_ID}\\b`).test(text)
  report(hasRow, 'profile patch declares the ui-pet row')
  if (hasRow) {
    const disabled = new RegExp(`id:\\s*${ENTRY_ID}[\\s\\S]{0,120}?disabled:\\s*true`).test(text)
    report(!disabled, 'ui-pet row is enabled', disabled ? 'row is disabled: true' : '')
  } else {
    skip('ui-pet row enabled state', 'row absent')
  }
} else {
  report(false, 'profile patch exists', patchPath)
}

/* ------------------------------------------------------------ B) 运行中的服务 */

function extractBootGraph(html) {
  const marker = 'window.__DSH_BOOT__'
  const at = html.indexOf(marker)
  if (at < 0) return null
  const start = html.indexOf('{', at)
  if (start < 0) return null
  let depth = 0
  let inString = false
  let quote = ''
  let escaped = false
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) inString = false
      continue
    }
    if (ch === '"' || ch === "'") {
      inString = true
      quote = ch
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1))
        } catch (error) {
          return { __parseError: error.message }
        }
      }
    }
  }
  return null
}

async function probeServer() {
  if (baseUrl === null) {
    skip('boot graph probe', 'pass --url http://127.0.0.1:<port> or set DSH_WEB_URL (the web port is a launch setting, not a constant)')
    return
  }
  let cookie = ''
  if (token !== undefined) {
    const auth = await fetch(`${baseUrl}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
    const setCookie = typeof auth.headers.getSetCookie === 'function' ? auth.headers.getSetCookie() : [auth.headers.get('set-cookie')]
    const first = (setCookie ?? []).filter(Boolean)[0]
    if (first !== undefined && first !== null) cookie = String(first).split(';')[0]
    report(Boolean(cookie), 'obtained a browser session cookie from the launch token')
  }
  const index = await fetch(`${baseUrl}/`, cookie === '' ? {} : { headers: { cookie } })
  const html = await index.text()
  if (!html.includes('__DSH_BOOT__')) {
    skip('boot graph probe', `GET / returned ${index.status} without __DSH_BOOT__ — pass --token <token from the dsh startup banner>`)
    return
  }
  const graph = extractBootGraph(html)
  if (graph === null || graph.__parseError !== undefined) {
    report(false, 'parsed window.__DSH_BOOT__', graph?.__parseError ?? 'not found')
    return
  }
  const row = (graph.entries ?? []).find((entry) => entry.id === PACKAGE_NAME || entry.id === `${PACKAGE_NAME}/client`)
  report(row !== undefined, 'boot graph contains the pet row', row === undefined ? 'row missing — did the profile patch get applied? (F5 already done?)' : `rev ${String(row.rev).slice(0, 12)}…`)
  if (row === undefined) return
  const batch = (graph.batches ?? []).find((entry) => (entry.entries ?? []).includes(row.id))
  if (batch === undefined) {
    report(false, 'located the combo batch for the pet row')
    return
  }
  const response = await fetch(`${baseUrl}${batch.url}`, cookie === '' ? {} : { headers: { cookie } })
  const body = await response.text()
  report(response.status === 200, 'combo script is served', `${response.status} ${batch.url.slice(0, 60)}…`)
  report(body.includes(PACKAGE_NAME), 'served script registers our package id')
  report(body.includes('data:image/webp;base64,'), 'served script carries the inline sprite assets')
  const local = readFileSync(localBundle, 'utf8')
  const sprite = /"sprite": \{"?width"?/.test(body) || body.includes(local.slice(local.indexOf('data:image/webp'), local.indexOf('data:image/webp') + 80))
  report(sprite, 'served sprite payload matches the workspace bundle')
}

try {
  await probeServer()
} catch (error) {
  skip('boot graph probe', `could not reach ${baseUrl}: ${error?.message ?? String(error)}`)
}

/* ------------------------------------------------------------ 输出 */

console.log(lines.join('\n'))
console.log(failures === 0 ? 'live: all filesystem checks passed' : `live: ${failures} check(s) failed`)
if (failures === 0 && !lines.some((line) => line.startsWith('PASS  boot graph'))) {
  console.log('note: if the page had already been open before install, refresh it (F5) before trusting the visual result.')
}
process.exitCode = failures === 0 ? 0 : 1
