/**
 * 浏览器半的接线测试：不需要真浏览器，也不需要真 React。
 *
 * 做法：给一个极简的 hooks 实现（useState / useEffect / useCallback 够用），
 * 用 `window.__ModuleLoader__.load` 把 `src/client/client.js` 真跑起来，然后像用户那样
 * 点按钮、往输入框里打字，最后检查 RPC 动作与渲染出来的文案。
 *
 * 锁的是「面板 ↔ 宿主」的约定，不是样式：
 *   - 列表里有「粘贴 JSON 导入」入口，首屏状态走 action=state
 *   - 输入停下来后预览走 action=import + dryRun=true，并显示台数 / 同名冲突
 *   - 点「导入」才发不带 dryRun 的 import，并回显导入了哪几台
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CLIENT_PATH = fileURLToPath(new URL('../src/client/client.js', import.meta.url))
const clientUrl = (tag) => `${pathToFileURL(CLIENT_PATH).href}?case=${tag}`

// ── 极简 React（只够这个面板用） ─────────────────────────────────────────────
function createReact() {
  const instances = new Map()
  const state = { effects: [], scheduled: false, root: null, tree: null, current: null }

  const depsEqual = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => Object.is(item, b[index]))

  const React = {
    createElement(type, props, ...children) {
      const merged = props ? { ...props } : {}
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged }
    },
    useState(initial) {
      const inst = state.current
      const index = inst.index++
      let slot = inst.hooks[index]
      if (slot === undefined) {
        slot = { value: typeof initial === 'function' ? initial() : initial }
        inst.hooks[index] = slot
      }
      const setValue = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        schedule()
      }
      return [slot.value, setValue]
    },
    useEffect(fn, deps) {
      const inst = state.current
      const index = inst.index++
      const existing = inst.hooks[index]
      if (existing !== undefined && deps !== undefined && depsEqual(deps, existing.deps)) return
      inst.hooks[index] = { deps, cleanup: existing?.cleanup }
      state.effects.push(() => {
        const slot = inst.hooks[index]
        if (typeof slot.cleanup === 'function') slot.cleanup()
        const cleanup = fn()
        slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
      })
    },
    useCallback(fn, deps) {
      const inst = state.current
      const index = inst.index++
      const existing = inst.hooks[index]
      if (existing !== undefined && deps !== undefined && depsEqual(deps, existing.deps)) return existing.fn
      inst.hooks[index] = { deps, fn }
      return fn
    },
  }

  function renderNode(node, path) {
    if (node === null || node === undefined || node === false || node === true) return null
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${path}/${index}`))
    if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
    const props = node.props || {}
    if (typeof node.type === 'function') {
      const inst = instances.get(path) ?? { hooks: [], index: 0 }
      inst.index = 0
      instances.set(path, inst)
      const previous = state.current
      state.current = inst
      let out
      try {
        out = node.type(props)
      } finally {
        state.current = previous
      }
      return renderNode(out, `${path}/out`)
    }
    const kids = props.children === undefined ? [] : Array.isArray(props.children) ? props.children : [props.children]
    return { type: node.type, props, children: kids.map((child, index) => renderNode(child, `${path}/${index}`)) }
  }

  function renderTree() {
    state.effects = []
    state.tree = renderNode(state.root, 'root')
    const jobs = state.effects
    state.effects = []
    for (const job of jobs) job()
  }

  function schedule() {
    if (state.scheduled) return
    state.scheduled = true
    queueMicrotask(() => {
      state.scheduled = false
      renderTree()
    })
  }

  function* walk(node) {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) {
      for (const child of node) yield* walk(child)
      return
    }
    yield node
    if (node.children) for (const child of node.children) yield* walk(child)
  }

  const textOf = (node) => {
    let out = ''
    for (const item of walk(node)) if (item.text !== undefined) out += item.text
    return out
  }

  return {
    React,
    mount(element) {
      state.root = element
      renderTree()
    },
    text() {
      return textOf(state.tree)
    },
    /** exact=false 时按“包含”匹配，方便点「粘贴 JSON 导入」这种长文案。 */
    button(label, exact = false) {
      for (const node of walk(state.tree)) {
        if (node.type !== 'button') continue
        const text = textOf(node)
        if (exact ? text === label : text.includes(label)) return node
      }
      return undefined
    },
    textarea() {
      for (const node of walk(state.tree)) if (node.type === 'textarea') return node
      return undefined
    },
  }
}

// ── 宿主替身 ────────────────────────────────────────────────────────────────
const STATE = {
  global: {
    scope: 'global',
    dir: null,
    file: 'C:\\Users\\demo\\.dsh\\profiles\\desktop\\mcp.yml',
    exists: true,
    status: 'empty',
    servers: [],
    warnings: [],
    agents: 1,
    mounted: 1,
    failed: 0,
  },
  project: {
    scope: 'project',
    dir: 'D:\\work\\demo',
    file: 'D:\\work\\demo\\.dsh\\mcp.yml',
    status: 'missing',
    servers: [],
    warnings: [],
    agents: 1,
    mounted: 0,
    failed: 0,
  },
  projects: [{ dir: 'D:\\work\\demo', sessions: 1, running: 1 }],
  legacy: { count: 0, names: [] },
  paths: { globalFile: 'C:\\mcp.yml', projectFile: '.dsh/mcp.yml', patchFile: 'C:\\p.yml' },
}

const PREVIEW = {
  file: 'C:\\Users\\demo\\.dsh\\profiles\\desktop\\mcp.yml',
  scope: 'global',
  shape: 'mcpServers',
  count: 2,
  imported: ['ida'],
  replaced: [],
  skipped: [{ name: 'web', reason: 'duplicate-name' }],
  warnings: [],
  preview: [
    { name: 'ida', transport: 'stdio', command: 'D:\\tools\\ida\\idalib-mcp.exe', args: ['--stdio'] },
    { name: 'web', transport: 'streamable-http', url: 'https://example.test/mcp' },
  ],
  dryRun: true,
}

const DONE = { ...PREVIEW, dryRun: false, written: true }

/** 起一份面板：注册全局替身 → import client.js（带 cache-busting）→ 挂载组件。 */
async function setup() {
  const ui = createReact()
  const calls = []
  const dict = {}

  const ctx = {
    connection: {
      rpc: {
        async call(channel, prefix, payload) {
          calls.push({ channel, prefix, action: payload.action, data: payload.data ?? {} })
          if (payload.action === 'state') return { ok: true, value: STATE }
          if (payload.action === 'import') return { ok: true, value: payload.data?.dryRun === true ? PREVIEW : DONE }
          return { ok: true, value: {} }
        },
      },
    },
    effect: (fn) => fn(),
    on: () => {},
    inject: () => () => {},
    logger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
    locale: {
      register(ns, value) {
        dict[ns] = value
        return () => {}
      },
      bind: (ns) => (key) => dict[ns]?.zh?.[key] ?? key,
    },
    slots: {
      inject: (name, fn) => fn(),
      register: (options, Component) => {
        ctx.__component = Component
        return () => {}
      },
    },
  }

  let captured
  globalThis.window = {
    __ModuleLoader__: { load: (def) => (captured = def) },
    localStorage: { getItem: () => '', setItem() {}, removeItem() {} },
    confirm: () => true,
  }
  globalThis.document = {
    getElementById: () => null,
    head: { appendChild() {} },
    createElement: () => ({ id: '', textContent: '' }),
  }

  await import(clientUrl(`${Date.now()}-${Math.random()}`))
  assert.equal(captured?.id, 'dsh-mcp-management', 'client.js 应该注册成 ModuleLoader 模块')
  captured
    .factory((id) => {
      if (id === 'react') return ui.React
      throw new Error(`unexpected module: ${id}`)
    })
    .apply(ctx)

  ui.mount(ui.React.createElement(ctx.__component, { ctx }))
  await new Promise((resolve) => setTimeout(resolve, 30))
  return { ui, calls }
}

test('面板：首屏渲染列表与「粘贴 JSON 导入」入口', async () => {
  const { ui, calls } = await setup()
  const shot = ui.text().slice(0, 400)
  assert.ok(ui.button('添加 MCP'), shot)
  assert.ok(ui.button('粘贴 JSON 导入', true), shot)
  assert.equal(calls[0].action, 'state')
  assert.equal(calls[0].channel, '/api')
  assert.equal(calls[0].prefix, 'mcp-management')
})

test('面板：输入 JSON 后走 dryRun 预览，点导入才写', async () => {
  const { ui, calls } = await setup()
  ui.button('粘贴 JSON 导入', true).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))

  const textarea = ui.textarea()
  assert.ok(textarea, '点开后应该出现粘贴框')
  textarea.props.onChange({ target: { value: '{"mcpServers":{"ida":{"command":"x.exe"}}}' } })
  await new Promise((resolve) => setTimeout(resolve, 600))

  const previewCalls = calls.filter((call) => call.action === 'import')
  assert.equal(previewCalls.length, 1, '输入停下后应该只发一次预览')
  assert.equal(previewCalls[0].data.dryRun, true)
  assert.equal(previewCalls[0].data.replace, false)

  const previewText = ui.text()
  assert.ok(previewText.includes('共 2 台'), previewText)
  assert.ok(previewText.includes('mcp__ida__*'), previewText)
  assert.ok(previewText.includes('同名已存在'), previewText)

  const confirm = ui.button('导入', true)
  assert.ok(confirm, '预览有结果时应该能点导入')
  assert.equal(confirm.props.disabled, false)
  confirm.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 40))

  const writeCalls = calls.filter((call) => call.action === 'import' && call.data.dryRun !== true)
  assert.equal(writeCalls.length, 1)
  assert.equal(writeCalls[0].data.text.includes('mcpServers'), true)
  assert.ok(ui.text().includes('已导入 1 台：ida'), ui.text().slice(-300))
  assert.ok(ui.text().includes('跳过同名 1 台'), ui.text().slice(-300))
})

// ── 设置导航图标 ────────────────────────────────────────────────────────────
/**
 * 宿主只按硬编码 id 给导航画图标，`settings.section` 没有 icon 字段；
 * 本插件靠“认领按钮 + CSS 伪元素”补一个 MCP mark。这里锁的是认领规则：
 * 只认 label 文本等于本页导航标题的那颗按钮，别的项一个都不许打标记。
 */
function navButton(text) {
  const attrs = {}
  return {
    textContent: text,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    setAttribute: (name, value) => {
      attrs[name] = value
    },
  }
}

async function setupNav(buttons, hasDialog = true) {
  let captured
  const dict = {}
  const ctx = {
    connection: undefined,
    effect: (fn) => fn(),
    on: () => {},
    inject: () => () => {},
    logger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
    locale: {
      register(ns, value) {
        dict[ns] = value
        return () => {}
      },
      bind: (ns) => (key) => dict[ns]?.zh?.[key] ?? key,
    },
    slots: { inject: () => () => {}, register: () => () => {} },
  }
  const dialog = hasDialog ? { querySelectorAll: () => buttons } : null

  globalThis.window = {
    __ModuleLoader__: { load: (def) => (captured = def) },
    localStorage: { getItem: () => '', setItem() {}, removeItem() {} },
    setTimeout,
    clearTimeout,
  }
  globalThis.document = {
    body: {},
    getElementById: () => null,
    head: { appendChild() {} },
    createElement: () => ({ id: '', textContent: '' }),
    querySelector: (selector) => (selector === '[data-shortcut-modal="settings"]' ? dialog : null),
    querySelectorAll: () => [],
  }
  globalThis.MutationObserver = class {
    constructor(callback) {
      globalThis.__navObserver = callback
    }
    observe() {}
    disconnect() {}
  }

  await import(clientUrl(`nav-${Date.now()}-${Math.random()}`))
  captured
    .factory((id) => {
      if (id === 'react') return createReact().React
      throw new Error(`unexpected module: ${id}`)
    })
    .apply(ctx)
}

test('设置导航：只给本页那颗按钮打 MCP 图标标记', async () => {
  const models = navButton('模型')
  const mine = navButton('MCP')
  const plugins = navButton('插件')
  await setupNav([models, mine, plugins])

  assert.equal(mine.getAttribute('data-mcp-nav'), '', '本页导航项要被认领')
  assert.equal(models.getAttribute('data-mcp-nav'), null, '别把模型那项也改了')
  assert.equal(plugins.getAttribute('data-mcp-nav'), null, '别把插件那项也改了')
})

test('设置导航：没打开设置面板时不碰任何东西', async () => {
  const mine = navButton('MCP')
  await setupNav([mine], false)
  assert.equal(mine.getAttribute('data-mcp-nav'), null, '面板还没开，什么都不该发生')

  globalThis.__navObserver()
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(mine.getAttribute('data-mcp-nav'), null, '被 DOM 变更叫醒也不该越界')
})
