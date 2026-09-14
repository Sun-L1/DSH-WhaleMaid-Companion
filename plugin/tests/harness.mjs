/**
 * Test harness for the generated client bundle.
 *
 * 这里装配的是**真实产物** plugin/lib/client.js：用假的 window.__ModuleLoader__ 捕获工厂、
 * 用假的 require('react') 满足基线依赖、用假的 document/localStorage/navigator 提供浏览器
 * 环境。任何越界（require 其它模块、调用 fetch、用到未桩的浏览器 API）都会立即失败。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const BUNDLE_FILE = join(ROOT, 'plugin', 'lib', 'client.js')
export const MANIFEST_FILE = join(ROOT, 'plugin', 'src', 'assets.gen.json')

/** 最小 React 桩：函数组件按调用求值，钩子直接返回桩值，便于断言产出的元素树。 */
export function createReactStub() {
  const cleanups = []
  const react = {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
      const merged = { ...(props ?? {}), children: flat }
      if (typeof type === 'function') return type(merged)
      return { type, props: merged }
    },
    useRef: (initial) => ({ current: initial }),
    useEffect: (effect) => {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    __cleanups: cleanups,
  }
  return react
}

export function createDomStub() {
  const created = []
  const listeners = new Map()
  const element = () => {
    const node = {
      tagName: 'div',
      style: {},
      attributes: {},
      children: [],
      textContent: '',
      setAttribute(name, value) {
        node.attributes[name] = value
      },
      append(child) {
        node.children.push(child)
      },
      remove() {
        node.removed = true
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
    }
    created.push(node)
    return node
  }
  const document = {
    visibilityState: 'visible',
    documentElement: { lang: 'zh-CN' },
    head: element(),
    body: element(),
    createElement: () => element(),
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
    querySelector: () => null,
  }
  return { document, listeners, created }
}

export function createStorageStub(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    __map: map,
  }
}

export function createWindowStub(dom) {
  const listeners = new Map()
  return {
    innerWidth: 1600,
    innerHeight: 900,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
    localStorage: undefined,
    __listeners: listeners,
    document: dom.document,
  }
}

/** 载入真实 bundle，返回注册信息与工厂导出的插件对象。 */
export function loadBundle(overrides = {}) {
  const source = readFileSync(BUNDLE_FILE, 'utf8')
  const dom = createDomStub()
  const windowStub = createWindowStub(dom)
  const storage = overrides.localStorage ?? createStorageStub()
  const react = createReactStub()
  const requested = []
  let registration = null

  windowStub.__ModuleLoader__ = {
    load(entry) {
      registration = entry
    },
  }
  const requireFn = (spec) => {
    requested.push(spec)
    if (spec === 'react') return react
    throw new Error(`bundle required a non-baseline module: ${spec}`)
  }
  // fetch 在这里被毒化：任何网络调用都会立刻炸掉测试。
  const fetchBomb = () => {
    throw new Error('bundle attempted a network call')
  }
  const factory = new Function(
    'window',
    'document',
    'localStorage',
    'navigator',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    source,
  )
  factory(
    windowStub,
    dom.document,
    storage,
    { language: 'zh-CN', languages: ['zh-CN'] },
    () => 0,
    () => {},
    fetchBomb,
    fetchBomb,
    fetchBomb,
  )
  if (registration === null) throw new Error('bundle did not call window.__ModuleLoader__.load')
  const exports = registration.factory(requireFn)
  return { id: registration.id, exports, window: windowStub, document: dom.document, dom, storage, react, requested, source }
}

/** 假 ctx：只提供桌宠声明需要的服务，外加可断言的注册表。 */
export function createCtx(sessions) {
  const registrations = []
  const injections = []
  const effects = []
  const localeRegistrations = []
  const ctx = {
    sessions,
    slots: {
      injectedKeys: injections,
      register(options, Component) {
        registrations.push({ options, Component })
        return () => {
          const index = registrations.findIndex((entry) => entry.options.id === options.id)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
      inject(key, callback) {
        injections.push(key)
        const dispose = callback()
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      },
    },
    locale: {
      register(ns, dicts) {
        localeRegistrations.push({ ns, dicts })
      },
    },
    effect(callback, label) {
      const dispose = callback()
      effects.push({ dispose, label })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    disposeAll() {
      for (const entry of effects.reverse()) {
        if (typeof entry.dispose === 'function') entry.dispose()
      }
      effects.length = 0
    },
  }
  return { ctx, registrations, injections, effects, localeRegistrations }
}

/** 可控 observable + 会话桩。 */
export function createStore(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }
}

export function createSessions({ sessionId = 'session-1' } = {}) {
  const list = createStore({ current: sessionId })
  const pressure = createStore(undefined)
  const face = createStore({ running: false, promptError: null, lastAgentError: null })
  const events = createStore({ entries: [], hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } })
  const bindings = []
  const sessions = {
    list,
    binding(id) {
      bindings.push(id)
      if (id === null || id === undefined) return undefined
      return {
        session: Object.assign(face, {
          projections: { faceOf: (key) => (key === 'contextPressure' ? pressure : createStore(undefined)) },
        }),
        eventSource: events,
      }
    },
    __list: list,
    __pressure: pressure,
    __face: face,
    __events: events,
    __bindings: bindings,
  }
  return sessions
}

/** 把 React 桩产出的元素树压平，便于断言 className。 */
export function flatten(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  out.push(node)
  if (node.props !== undefined) flatten(node.props.children, out)
  return out
}

export function classNameOf(node) {
  const value = node?.props?.className
  return typeof value === 'string' ? value : ''
}

export function textOf(node) {
  return flatten(node)
    .map((element) => element.props?.children)
    .flat(Infinity)
    .filter((child) => typeof child === 'string')
    .join(' ')
}
