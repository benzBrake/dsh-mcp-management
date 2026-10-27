/**
 * 服务器清单文件（mcp.yml / .dsh/mcp.yml）：读、规范化、写。
 *
 * 契约：readServersFile 永远返回可渲染结果，绝不抛。
 *   status: missing | empty | ok | invalid
 * invalid 时调用方（runtime）保留上一份可用挂载，避免一个手抖把能用的 MCP 全掐掉。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { SERVER_NAME_RE } from './constants.js'
import { errorText, isRecord, isStringRecord, toStringMap } from './util.js'
import { yamlSchema } from './yaml.js'

/**
 * 读一个 MCP 清单文件，永远返回一个可渲染的结果，绝不抛。
 * status: missing | empty | ok | invalid
 */
export async function readServersFile(file) {
  const out = {
    file,
    exists: false,
    status: 'missing',
    servers: [],
    warnings: [],
    error: undefined,
    updatedAt: undefined,
  }
  if (!existsSync(file)) return out
  out.exists = true
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    out.status = 'invalid'
    out.error = `读取失败：${errorText(error)}`
    return out
  }
  if (text.trim() === '') {
    out.status = 'empty'
    return out
  }
  let parsed
  try {
    const { yaml, schema } = await yamlSchema()
    parsed = yaml.load(text, { schema })
  } catch (error) {
    out.status = 'invalid'
    out.error = `YAML 解析失败：${errorText(error)}`
    return out
  }
  if (parsed === null || parsed === undefined) {
    out.status = 'empty'
    return out
  }
  let rows
  if (Array.isArray(parsed)) {
    rows = parsed
  } else if (isRecord(parsed) && 'servers' in parsed) {
    if (!Array.isArray(parsed.servers)) {
      out.status = 'invalid'
      out.error = '`servers:` 必须是一个列表'
      return out
    }
    rows = parsed.servers
  } else {
    out.status = 'invalid'
    out.error = '顶层需要是一个服务器列表，或包含 `servers:` 列表的对象'
    return out
  }

  const seen = new Set()
  rows.forEach((row, index) => {
    const normalized = normalizeServerRow(row, index)
    if (normalized.error !== undefined) {
      out.warnings.push(`第 ${index + 1} 条：${normalized.error}`)
      return
    }
    const server = normalized.server
    if (seen.has(server.name)) {
      out.warnings.push(`第 ${index + 1} 条：名称 "${server.name}" 重复，已忽略`)
      return
    }
    seen.add(server.name)
    out.servers.push(server)
  })
  out.status = rows.length === 0 ? 'empty' : 'ok'
  return out
}

/** 单条服务器声明的规范化：同时兼容「简洁写法」和「cordis mcp-client 行写法」。 */
export function normalizeServerRow(row, index) {
  if (!isRecord(row)) return { error: '不是一个对象' }
  const rawName = typeof row['name'] === 'string' ? row['name'] : ''
  const looksLikeCordisRow = isRecord(row['config']) || rawName.includes('/') || rawName.startsWith('@')
  const source = looksLikeCordisRow
    ? (isRecord(row['config']) ? row['config'] : {})
    : row
  const name =
    typeof source['serverName'] === 'string' && source['serverName'] !== ''
      ? source['serverName']
      : typeof source['name'] === 'string'
        ? source['name']
        : ''
  if (!SERVER_NAME_RE.test(name)) {
    return {
      error: `缺少合法的 name（服务器名），需要匹配 [A-Za-z0-9_-]{1,32}，例如 "ida"`,
    }
  }
  const transport =
    source['transport'] === 'stdio'
      ? 'stdio'
      : source['transport'] === 'streamable-http'
        ? 'streamable-http'
        : typeof source['url'] === 'string' && source['url'] !== ''
          ? 'streamable-http'
          : 'stdio'
  const server = { name, transport }
  if (looksLikeCordisRow && row['disabled'] === true) server.enabled = false
  if (source['enabled'] === false) server.enabled = false

  if (transport === 'stdio') {
    if (typeof source['command'] !== 'string' || source['command'].trim() === '') {
      return { error: `"${name}" 是 stdio 传输，但缺少 command` }
    }
    server.command = source['command'].trim()
    if (Array.isArray(source['args'])) {
      const args = source['args'].map((x) => String(x))
      if (args.length > 0) server.args = args
    }
    if (typeof source['cwd'] === 'string' && source['cwd'].trim() !== '') server.cwd = source['cwd'].trim()
  } else {
    if (typeof source['url'] !== 'string' || !/^https?:\/\/.+/.test(source['url'])) {
      return { error: `"${name}" 是 streamable-http 传输，但缺少 http(s) URL` }
    }
    server.url = source['url'].trim()
    if (isRecord(source['headers']) && Object.keys(source['headers']).length > 0) {
      server.headers = toStringMap(source['headers'])
    }
  }
  if (isRecord(source['env']) && Object.keys(source['env']).length > 0) {
    server.env = toStringMap(source['env'])
  }
  const timeout = Number(source['toolCallTimeoutMs'])
  if (Number.isFinite(timeout) && timeout > 0) server.toolCallTimeoutMs = timeout
  return { server }
}

/** 写清单文件：先备份成 <file>.bak，再整份覆盖（不合并，避免 YAML 里堆注释垃圾）。 */
export async function writeServersFile(file, servers, header) {
  const { yaml } = await yamlSchema()
  mkdirSync(dirname(file), { recursive: true })
  const doc = { servers: servers.map(toFileRow) }
  const text = `${header}${yaml.dump(doc, { lineWidth: 120, noRefs: true })}`
  if (existsSync(file)) {
    try {
      copyFileSync(file, `${file}.bak`)
    } catch {
      /* 备份失败不影响主流程 */
    }
  }
  writeFileSync(file, text, 'utf8')
}

/** 内存里的 server → 磁盘上的一行（字段顺序固定，便于 diff）。 */
export function toFileRow(server) {
  const row = { name: server.name, transport: server.transport }
  if (server.enabled === false) row.enabled = false
  if (server.transport === 'stdio') {
    row.command = server.command
    if (Array.isArray(server.args) && server.args.length > 0) row.args = server.args
    if (typeof server.cwd === 'string' && server.cwd !== '') row.cwd = server.cwd
  } else {
    row.url = server.url
    if (isRecord(server.headers) && Object.keys(server.headers).length > 0) row.headers = server.headers
  }
  if (isRecord(server.env) && Object.keys(server.env).length > 0) row.env = server.env
  if (typeof server.toolCallTimeoutMs === 'number' && server.toolCallTimeoutMs > 0) {
    row.toolCallTimeoutMs = server.toolCallTimeoutMs
  }
  return row
}

/**
 * 表单提交上来的服务器字段校验。
 * 返回「字段名 → 错误文案」的映射，空对象表示通过（RPC 层会把它放进 details.fields）。
 */
export function validateServerInput(server) {
  const fields = {}
  if (!isRecord(server)) return { _: '请求内容不合法' }
  const name = typeof server.name === 'string' ? server.name.trim() : ''
  if (!SERVER_NAME_RE.test(name)) fields['name'] = 'name 需要匹配 [A-Za-z0-9_-]{1,32}'
  const transport = server.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  if (transport === 'stdio') {
    if (typeof server.command !== 'string' || server.command.trim() === '') fields['command'] = 'stdio 需要可执行命令'
  } else if (typeof server.url !== 'string' || !/^https?:\/\/.+/.test(server.url)) {
    fields['url'] = 'streamable-http 需要 http(s):// URL'
  }
  if (server.env !== undefined && !isStringRecord(server.env)) fields['env'] = 'env 必须是字符串映射'
  if (server.headers !== undefined && !isStringRecord(server.headers)) fields['headers'] = 'headers 必须是字符串映射'
  return fields
}
