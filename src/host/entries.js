/**
 * Loader 行：把一台 MCP 服务器变成一棵内存 EntryTree 里的一行。
 *
 * 做法与 @deepseek-ai/dsh-agent-preset-registry 的 PresetTree 同源——
 * 不去 import 那个包，而是沿 ctx.loader 的原型链把 EntryTree 构造函数摸出来，
 * 这样插件不绑定具体的包解析路径。write 打成 noop：这套行只存在于内存。
 */

import { MCP_CLIENT } from './constants.js'
import { errorText, isRecord } from './util.js'

/** 从已加载的 Loader 实例向上找到 EntryTree 构造函数，避免依赖包解析。 */
export function entryTreeCtor(ctx) {
  let proto = Object.getPrototypeOf(ctx.loader)
  while (proto !== null && proto !== Object.prototype) {
    const ctor = proto.constructor
    if (typeof ctor === 'function' && ctor.name === 'EntryTree') return ctor
    proto = Object.getPrototypeOf(proto)
  }
  return undefined
}

/** 内存树：不落盘，只把行挂进当前上下文（或其 extend 出来的子作用域）。 */
export function createTree(ctx, baseUrl) {
  const ctor = entryTreeCtor(ctx)
  if (ctor === undefined) throw new Error('找不到 EntryTree 构造函数，无法挂载 MCP')
  const scoped = typeof baseUrl === 'string' && baseUrl !== '' ? ctx.extend({ baseUrl }) : ctx
  const tree = new ctor(scoped)
  tree.write = () => {}
  // EntryTree 的构造器会把自身登记到 entry.subtree，那会让 Loader 的
  // entries() 把运行时的 MCP 行当成 profile 配置，必须抹掉。
  const owner = tree.ctx?.fiber?.entry
  if (owner !== undefined) {
    delete owner.subtree
    delete owner.subgroup
  }
  return tree
}

export function entryIdOf(name) {
  return `mcp-${String(name).replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/** 一台服务器 → 一条 mcp-client loader 行。 */
export function toEntryRow(server) {
  const config = { serverName: server.name, transport: server.transport }
  if (server.transport === 'stdio') {
    config.command = server.command
    if (Array.isArray(server.args) && server.args.length > 0) config.args = server.args
    if (typeof server.cwd === 'string' && server.cwd !== '') config.cwd = server.cwd
  } else {
    config.url = server.url
    if (isRecord(server.headers) && Object.keys(server.headers).length > 0) config.headers = server.headers
  }
  if (isRecord(server.env) && Object.keys(server.env).length > 0) config.env = server.env
  if (typeof server.toolCallTimeoutMs === 'number' && server.toolCallTimeoutMs > 0) {
    config.toolCallTimeoutMs = server.toolCallTimeoutMs
  }
  const row = { id: entryIdOf(server.name), name: MCP_CLIENT, config }
  if (server.enabled === false) row.disabled = true
  return row
}

export function stopTree(tree) {
  try {
    tree?.root?.stop()
  } catch {
    /* 已停止 */
  }
}

/** serverName 冲突（旧条目还没被 Loader 拆掉）时短暂重试。 */
export async function updateWithRetry(tree, rows, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await tree.root.update(rows)
      return
    } catch (error) {
      lastError = error
      const message = errorText(error)
      const transient = /already in use|already exists|not active|disposed/i.test(message)
      if (!transient || attempt === attempts) throw error
      await new Promise((r) => setTimeout(r, 400 * attempt))
    }
  }
  throw lastError
}
