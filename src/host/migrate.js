/**
 * 旧配置迁移：profile 的 cordis.patch.yml 顶层还会出现 mcp-client 行
 * （历史遗留的“全局 MCP”写法）。这里只做两件事：找出来、摘掉。
 * 真正搬到 mcp.yml 的动作在 rpc.js 的 opMigrate 里（要先合并去重）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { MCP_CLIENT } from './constants.js'
import { yamlSchema } from './yaml.js'

export async function readPatchRows(file) {
  const { yaml, schema } = await yamlSchema()
  if (!existsSync(file)) return { rows: [], header: '', exists: false }
  const text = readFileSync(file, 'utf8')
  const header = splitHeader(text)
  if (text.trim() === '') return { rows: [], header, exists: true }
  const parsed = yaml.load(text, { schema })
  if (parsed === null || parsed === undefined) return { rows: [], header, exists: true }
  if (!Array.isArray(parsed)) throw new Error(`${file} 顶层必须是数组`)
  return { rows: parsed, header, exists: true }
}

/** 文件开头的注释块：补丁被整份重写时要把说明保留下来。 */
export function splitHeader(text) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*-\s/.test(line)) break
    out.push(line)
  }
  return out.join('\n').replace(/\s*$/, '')
}

export async function writePatchRows(file, rows, header) {
  const { yaml, schema } = await yamlSchema()
  const body = rows.length > 0 ? yaml.dump(rows, { schema, lineWidth: 120 }) : '[]\n'
  const head = header !== undefined && header.trim() !== '' ? `${header}\n` : ''
  mkdirSync(dirname(file), { recursive: true })
  if (existsSync(file)) {
    try {
      copyFileSync(file, `${file}.bak-migrate`)
    } catch {
      /* 备份失败不影响主流程 */
    }
  }
  writeFileSync(file, `${head}${body}`, 'utf8')
}

/** 把补丁文件里所有顶层 mcp-client 行摊平（含 insert 包裹）。 */
export function collectPatchMcpRows(rows) {
  const found = []
  const visit = (container, owner) => {
    for (let index = container.length - 1; index >= 0; index--) {
      const row = container[index]
      if (row?.name === MCP_CLIENT) found.push({ container, owner, index, row })
    }
  }
  visit(rows, undefined)
  for (const row of rows) {
    if (Array.isArray(row?.insert)) visit(row.insert, row)
  }
  return found
}

export function removePatchMcpRows(rows, found) {
  // 按容器分组、从后往前删，保持下标有效
  const byContainer = new Map()
  for (const item of found) {
    const list = byContainer.get(item.container) ?? []
    list.push(item)
    byContainer.set(item.container, list)
  }
  for (const [container, items] of byContainer) {
    items.sort((a, b) => b.index - a.index)
    for (const item of items) container.splice(item.index, 1)
  }
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]
    if (Array.isArray(row?.insert) && row.insert.length === 0) rows.splice(index, 1)
  }
}
