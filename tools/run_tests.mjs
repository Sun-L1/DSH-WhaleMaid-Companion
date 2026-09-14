#!/usr/bin/env node
/**
 * 测试入口：在**同一个进程**内导入全部 node:test 用例。
 *
 * 为什么不直接 `node --test plugin/tests`：本机沙箱禁止子进程使用管道 stdio
 * （node --test 默认每个测试文件 spawn 一个子进程并捕获其输出），会以 EPERM 失败。
 * 在单进程内跑等价且更快。
 *
 * 用法：node tools/run_tests.mjs
 */

import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(ROOT, 'plugin', 'tests')

const files = readdirSync(dir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

if (files.length === 0) {
  console.error('no test files found in plugin/tests')
  process.exitCode = 1
} else {
  for (const file of files) {
    await import(pathToFileURL(join(dir, file)).href)
  }
}
