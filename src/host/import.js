/**
 * 「粘贴别人给的 MCP JSON」导入：宽松解析 → 归一化成 server 对象。
 *
 * 别人给的格式没法约定，所以外层形状全试一遍：
 *   [{ name, command|url, … }, …]                  数组，每项一台
 *   { mcpServers: { name: { … } } }                Claude Desktop / Cursor / Cline / Continue
 *   { servers: { … } | [ … ] }                     VS Code / 部分国内客户端
 *   { name: { command|url, … } }                   裸映射（键就是服务器名）
 *   { name, command|url, … }                       单台服务器
 * 内层字段也顺手兼容：type / transportType 同义词、baseUrl、command 数组、
 * args 字符串、env 数组、disabled、cordis 行的 config 包裹。
 *
 * 契约：
 *   - 整体不是 JSON → 抛错（rpc 层转 `json-invalid`）；
 *   - 单个条目有问题 → 只进 warnings，不影响其余条目；
 *   - 返回值里的 servers 已经过 servers.js 的 normalizeServerRow，可直接落盘。
 */

import { normalizeServerRow } from './servers.js'
import { errorText, isRecord } from './util.js'

/** 常见的“外面还包一层”的键，按优先级排。 */
const WRAPPER_KEYS = ['mcpServers', 'mcp_servers', 'mcpservers', 'mcp', 'servers', 'mcpServersList']

/** 出现在一个对象上就说明“这个对象本身就是一台服务器”。 */
const SERVER_KEYS = ['command', 'url', 'baseUrl', 'serverUrl', 'uri', 'type', 'transport', 'serverName', 'config']

/**
 * 解析粘贴进来的文本。抛错 = 整段不是 JSON；返回值里可能还有 warnings。
 * @returns {{ servers: Array<object>, warnings: string[], shape: string }}
 */
export function parseMcpJson(text) {
  const { value, repaired } = parseJsonLoose(text)
  const warnings = []
  if (repaired) warnings.push('JSON 里有尾随逗号，已按标准 JSON 修正')
  const shape = shapeOf(value)
  const entries = collectEntries(value, warnings)
  const servers = []
  const seen = new Set()
  entries.forEach((entry, index) => {
    const server = buildServer(entry, index, warnings)
    if (server === undefined) return
    if (seen.has(server.name)) {
      warnings.push(`第 ${index + 1} 条：名称 "${server.name}" 在这一份 JSON 里重复，只保留第一条`)
      return
    }
    seen.add(server.name)
    servers.push(server)
  })
  if (entries.length === 0) warnings.push('没有从这份 JSON 里找到 MCP 服务器声明')
  return { servers, warnings, shape }
}

/** 只做“这段文本能不能变成服务器”的判断，给面板做即时预览也用得上。 */
export function previewMcpJson(text) {
  const parsed = parseMcpJson(text)
  return { count: parsed.servers.length, servers: parsed.servers, warnings: parsed.warnings, shape: parsed.shape }
}

// ── 文本 → JSON ─────────────────────────────────────────────────────────────

/**
 * 去掉代码围栏 / BOM / 整行注释（别人从聊天窗口复制时经常带着），
 * 然后按标准 JSON 解析；失败时再试一次“删尾随逗号”。
 */
export function parseJsonLoose(text) {
  const body = stripJsonWrapper(text)
  if (body === '') throw new Error('内容为空')
  try {
    return { value: JSON.parse(body), repaired: false }
  } catch (first) {
    const repairedText = dropTrailingCommas(body)
    if (repairedText !== body) {
      try {
        return { value: JSON.parse(repairedText), repaired: true }
      } catch (second) {
        throw new Error(`JSON 解析失败：${errorText(second)}`)
      }
    }
    throw new Error(`JSON 解析失败：${errorText(first)}`)
  }
}

export function stripJsonWrapper(text) {
  let body = String(text === undefined || text === null ? '' : text)
    .replace(/^\uFEFF/, '')
    .trim()
  const fenced = /^```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(body)
  if (fenced !== null) body = fenced[1].trim()
  // 只删整行注释：行内的 // 可能是 URL，不能碰
  body = body
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
    .trim()
  return body
}

/** 删掉对象 / 数组末尾多出来的逗号（字符串里的逗号不受影响）。 */
export function dropTrailingCommas(text) {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j += 1
      if (text[j] === '}' || text[j] === ']') continue
    }
    out += ch
  }
  return out
}

// ── 外层形状 → 条目列表 ─────────────────────────────────────────────────────

function shapeOf(value) {
  if (Array.isArray(value)) return 'array'
  if (!isRecord(value)) return 'unknown'
  const wrapper = WRAPPER_KEYS.find((key) => value[key] !== undefined)
  if (wrapper !== undefined) return wrapper
  if (looksLikeServer(value)) return 'server'
  return 'map'
}

function looksLikeServer(node) {
  if (!isRecord(node)) return false
  return SERVER_KEYS.some((key) => node[key] !== undefined)
}

/**
 * 把任意形状摊平成 [{ row, nameHint? }]。
 * nameHint 只在“键名就是服务器名”的形状里出现。
 */
function collectEntries(value, warnings) {
  const out = []
  const visit = (node, depth) => {
    if (depth > 4) {
      warnings.push('JSON 嵌套层数过多，后面的内容已跳过')
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item) => {
        if (!isRecord(item)) {
          warnings.push('数组里有一条不是对象，已跳过')
          return
        }
        if (looksLikeServer(item)) {
          out.push({ row: item })
          return
        }
        const keys = Object.keys(item)
        if (keys.length === 0) {
          warnings.push('数组里有一条是空对象，已跳过')
          return
        }
        // 数组里塞映射： [{ "ida": { … }, "web": { … } } ]
        if (keys.every((key) => isRecord(item[key]) || typeof item[key] === 'string')) {
          out.push(...toNameEntries(item))
          return
        }
        warnings.push('数组里有一条既不像服务器也不是名称映射，已跳过')
      })
      return
    }
    if (!isRecord(node)) {
      warnings.push('顶层需要是对象或数组')
      return
    }
    const wrapper = WRAPPER_KEYS.find((key) => node[key] !== undefined)
    if (wrapper !== undefined) {
      const inner = node[wrapper]
      if (Array.isArray(inner) || isRecord(inner)) {
        visit(inner, depth + 1)
        return
      }
      warnings.push(`"${wrapper}" 既不是对象也不是数组，已忽略`)
    }
    if (looksLikeServer(node)) {
      out.push({ row: node })
      return
    }
    const entries = toNameEntries(node)
    if (entries.length > 0) {
      out.push(...entries)
      return
    }
    warnings.push('顶层对象里没有可识别的服务器')
  }
  visit(value, 0)
  return out
}

/** 映射 → 条目；值是字符串时当成命令（有些客户端就这么写）。 */
function toNameEntries(map) {
  const out = []
  for (const [name, config] of Object.entries(map)) {
    if (isRecord(config)) out.push({ row: config, nameHint: name })
    else if (typeof config === 'string' && config.trim() !== '') out.push({ row: { command: config }, nameHint: name })
    else out.push({ row: config, nameHint: name })
  }
  return out
}

// ── 条目 → 服务器 ───────────────────────────────────────────────────────────

function buildServer(entry, index, warnings) {
  const label = `第 ${index + 1} 条`
  const row = entry.row
  if (!isRecord(row)) {
    warnings.push(`${label}：不是一个对象，已跳过`)
    return undefined
  }
  const src = { ...(isRecord(row['config']) ? row['config'] : row) }
  if (row['disabled'] === true && src['enabled'] === undefined) src['enabled'] = false

  const rawName = firstString([entry.nameHint, src['serverName'], src['name']])
  if (rawName === '') {
    warnings.push(`${label}：缺少 name（服务器名），已跳过`)
    return undefined
  }
  const name = sanitizeName(rawName)
  if (name !== rawName) warnings.push(`${label}：name "${rawName}" 含非法字符，已改成 "${name}"`)
  if (name === '') {
    warnings.push(`${label}：name 全是非法字符，已跳过`)
    return undefined
  }
  src['name'] = name
  delete src['serverName']

  // transport / type / transportType：别人给的枚举名五花八门
  const typeValue = firstString([src['transport'], src['type'], src['transportType'], src['connectionType']])
  if (typeValue !== '') {
    const mapped = mapTransport(typeValue)
    if (mapped === undefined) warnings.push(`${label}：不认识的传输方式 "${typeValue}"，按字段推断`)
    else src['transport'] = mapped
    if (/sse/i.test(typeValue)) warnings.push(`${label}：SSE 端点按 streamable-http 保存（本插件只有 stdio / streamable-http）`)
  }

  if (src['url'] === undefined) {
    const alt = firstString([src['baseUrl'], src['serverUrl'], src['uri'], src['endpoint']])
    if (alt !== '') src['url'] = alt
  }

  // command 写成数组：["npx", "-y", "pkg"]（Zed / 部分客户端）
  if (Array.isArray(src['command'])) {
    const parts = src['command'].map((item) => String(item))
    src['command'] = parts[0]
    const rest = [...parts.slice(1), ...toArgv(src['args'])]
    if (rest.length > 0) src['args'] = rest
    else delete src['args']
  } else {
    const argv = toArgv(src['args'])
    if (argv.length > 0) src['args'] = argv
    else delete src['args']
  }

  // env 写成 ["KEY=VALUE", …]
  if (Array.isArray(src['env'])) src['env'] = envArrayToMap(src['env'])

  // transport 说是 stdio，但只有 url、没有 command：按 URL 处理，别整条丢掉
  if (src['transport'] === 'stdio' && (typeof src['command'] !== 'string' || src['command'].trim() === '')) {
    if (typeof src['url'] === 'string' && src['url'] !== '') {
      src['transport'] = 'streamable-http'
      warnings.push(`${label}：声明是 stdio 却没有 command，按 URL 走了 streamable-http`)
    }
  }

  const normalized = normalizeServerRow(src, index)
  if (normalized.error !== undefined) {
    warnings.push(`${label}（${name}）：${normalized.error}`)
    return undefined
  }
  return normalized.server
}

const TRANSPORT_ALIASES = new Map([
  ['stdio', 'stdio'],
  ['local', 'stdio'],
  ['process', 'stdio'],
  ['child-process', 'stdio'],
  ['builtin', 'stdio'],
  ['streamable-http', 'streamable-http'],
  ['streamablehttp', 'streamable-http'],
  ['streamable', 'streamable-http'],
  ['http', 'streamable-http'],
  ['https', 'streamable-http'],
  ['remote', 'streamable-http'],
  ['sse', 'streamable-http'],
  ['http-sse', 'streamable-http'],
  ['sse-http', 'streamable-http'],
])

function mapTransport(value) {
  const key = String(value).trim().toLowerCase().replace(/[\s_]+/g, '-')
  return TRANSPORT_ALIASES.get(key)
}

function sanitizeName(raw) {
  return String(raw).trim().replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 32)
}

function toArgv(args) {
  if (Array.isArray(args)) return args.map((item) => String(item))
  if (typeof args === 'string') return args.trim() === '' ? [] : [args]
  return []
}

function envArrayToMap(items) {
  const out = {}
  for (const item of items) {
    const text = String(item)
    const idx = text.indexOf('=')
    if (idx <= 0) continue
    out[text.slice(0, idx).trim()] = text.slice(idx + 1)
  }
  return out
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}
