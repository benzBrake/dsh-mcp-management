/**
 * RPC 层：浏览器面板 ↔ 宿主的唯一通道。
 *
 *   POST /api/mcp-management
 *   { type: 'client-request', rpcId, payload: { action, data } }
 *   → { type: 'server-response', rpcId, result: { ok, value } | { ok:false, error } }
 *
 * 动作：state save remove toggle init import migrate reload probe。
 * scope 用 global / project；project 作用域再带一个 dir（绝对路径，缺省取当前会话目录）。
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { GLOBAL_FILE_HEADER, GLOBAL_SCOPE, PROJECT_FILE_HEADER, PROJECT_SCOPE } from './constants.js'
import { parseMcpJson } from './import.js'
import { collectPatchMcpRows, readPatchRows, removePatchMcpRows, writePatchRows } from './migrate.js'
import { samePath } from './paths.js'
import { probeServer } from './probe.js'
import { normalizeServerRow, readServersFile, validateServerInput, writeServersFile } from './servers.js'
import { errorText, isRecord, toStringMap } from './util.js'

// ── envelope ────────────────────────────────────────────────────────────────
export function ok(value) {
  return { ok: true, value }
}

export function fail(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

// ── 作用域 ↔ 文件 ───────────────────────────────────────────────────────────
export function projectInventory(runtime) {
  const byDir = new Map()
  const keyOf = (dir) => String(dir).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  for (const agent of runtime.liveAgents()) {
    const dir = runtime.projectDirOf(agent)
    if (dir === undefined) continue
    const entry = byDir.get(keyOf(dir)) ?? { dir, sessions: 0, running: 0 }
    entry.sessions += 1
    if (agent.status === 'running') entry.running += 1
    byDir.set(keyOf(dir), entry)
  }
  for (const state of runtime.runtime.agents.values()) {
    if (!byDir.has(keyOf(state.dir))) byDir.set(keyOf(state.dir), { dir: state.dir, sessions: 0, running: 0 })
  }
  return [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir))
}

export function guessProjectDir(runtime) {
  const agents = runtime.liveAgents()
  const running = agents.find((agent) => agent.status === 'running')
  const chosen = running ?? agents[agents.length - 1]
  const dir = chosen === undefined ? undefined : runtime.projectDirOf(chosen)
  if (dir !== undefined) return dir
  return process.cwd()
}

/** 某个作用域当前「有多少会话看得到 / 挂上了」。 */
export function mountSummary(runtime, dir) {
  const agents = runtime.liveAgents()
  if (dir === undefined) {
    const mounted = runtime.runtime.global.tree === undefined ? 0 : agents.length
    const failed = runtime.runtime.global.mountError === undefined ? 0 : 1
    return { agents: agents.length, mounted, failed }
  }
  const states = [...runtime.runtime.agents.values()].filter((state) => samePath(state.dir, dir))
  const live = agents.filter((agent) => samePath(runtime.projectDirOf(agent), dir)).length
  return {
    agents: Math.max(states.length, live),
    mounted: states.filter((state) => state.tree !== undefined).length,
    failed: states.filter((state) => state.mountError !== undefined).length,
  }
}

export async function describeScope(runtime, scope, dir) {
  if (scope === GLOBAL_SCOPE) {
    const read = await readServersFile(runtime.paths.globalFile)
    return {
      scope,
      dir: undefined,
      file: read.file,
      exists: read.exists,
      status: read.status,
      servers: read.servers,
      warnings: read.warnings,
      error: read.error,
      mountError: runtime.runtime.global.mountError,
      ...mountSummary(runtime, undefined),
    }
  }
  const projectDir = typeof dir === 'string' && dir.trim() !== '' ? resolve(dir.trim()) : guessProjectDir(runtime)
  const file = runtime.projectFileOf(projectDir)
  const read = await readServersFile(file)
  const state = [...runtime.runtime.agents.values()].find((item) => samePath(item.dir, projectDir))
  return {
    scope,
    dir: projectDir,
    file: read.file,
    exists: read.exists,
    status: read.status,
    servers: read.servers,
    warnings: read.warnings,
    error: read.error,
    mountError: state?.mountError,
    ...mountSummary(runtime, projectDir),
  }
}

export function fileForScope(runtime, scope, dir) {
  if (scope === GLOBAL_SCOPE) return runtime.paths.globalFile
  const projectDir = typeof dir === 'string' && dir.trim() !== '' ? resolve(dir.trim()) : guessProjectDir(runtime)
  return runtime.projectFileOf(projectDir)
}

// ── 动作 ────────────────────────────────────────────────────────────────────
export async function opState(runtime, payload) {
  const global = await describeScope(runtime, GLOBAL_SCOPE)
  const project = await describeScope(runtime, PROJECT_SCOPE, payload?.dir)
  let legacy = { count: 0, names: [] }
  try {
    const { rows } = await readPatchRows(runtime.paths.patchFile)
    const found = collectPatchMcpRows(rows)
    legacy = {
      count: found.length,
      names: found.map((item) => item.row?.config?.serverName ?? item.row?.id).filter(Boolean),
    }
  } catch {
    /* 补丁文件坏了不影响 MCP 面板 */
  }
  return ok({
    global,
    project,
    projects: projectInventory(runtime),
    legacy,
    paths: {
      globalFile: runtime.paths.globalFile,
      projectFile: runtime.paths.projectFile,
      patchFile: runtime.paths.patchFile,
    },
  })
}

export async function opSave(runtime, payload) {
  const scope = payload?.scope === PROJECT_SCOPE ? PROJECT_SCOPE : GLOBAL_SCOPE
  const file = fileForScope(runtime, scope, payload?.dir)
  const server = payload?.server ?? {}
  const fields = validateServerInput(server)
  if (Object.keys(fields).length > 0) return fail('invalid-config', 'MCP 服务器配置不合法', { fields })

  const read = await readServersFile(file)
  if (read.status === 'invalid' && payload?.overwrite !== true) {
    return fail('file-invalid', `${file} 解析失败，先修复或选择覆盖`, { file, error: read.error })
  }
  const list = read.status === 'invalid' ? [] : read.servers
  const originalName = typeof payload?.originalName === 'string' ? payload.originalName : ''
  const normalized = {
    name: server.name.trim(),
    transport: server.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
    enabled: server.enabled !== false,
  }
  if (normalized.transport === 'stdio') {
    normalized.command = server.command.trim()
    if (Array.isArray(server.args) && server.args.length > 0) normalized.args = server.args.map((x) => String(x))
    if (typeof server.cwd === 'string' && server.cwd.trim() !== '') normalized.cwd = server.cwd.trim()
  } else {
    normalized.url = server.url.trim()
    if (isRecord(server.headers) && Object.keys(server.headers).length > 0) normalized.headers = toStringMap(server.headers)
  }
  if (isRecord(server.env) && Object.keys(server.env).length > 0) normalized.env = toStringMap(server.env)
  if (server.toolCallTimeoutMs !== undefined && server.toolCallTimeoutMs !== null && server.toolCallTimeoutMs !== '') {
    const timeout = Number(server.toolCallTimeoutMs)
    if (Number.isFinite(timeout) && timeout > 0) normalized.toolCallTimeoutMs = timeout
  }

  const index = originalName === '' ? -1 : list.findIndex((item) => item.name === originalName)
  const clash = list.findIndex((item, i) => i !== index && item.name === normalized.name)
  if (clash !== -1) return fail('duplicate-name', `已经有一台叫 "${normalized.name}" 的 MCP 了`)
  if (index === -1) list.push(normalized)
  else list[index] = normalized

  const header = scope === GLOBAL_SCOPE ? GLOBAL_FILE_HEADER : PROJECT_FILE_HEADER
  await writeServersFile(file, list, header)
  await resync(runtime, scope, payload?.dir)
  return ok({ saved: normalized.name, file, scope })
}

/**
 * 从别处粘来的 MCP JSON 批量导入。
 *
 * data: { scope, dir?, text, replace?, overwrite?, dryRun? }
 *   replace  同名服务器直接覆盖（缺省跳过并在结果里列出来）
 *   overwrite 文件本身解析不了时也照写（与 save 的 overwrite 同义）
 *   dryRun   只解析、只算冲突，不落盘 —— 面板的即时预览走这条
 *
 * 整段不是 JSON → json-invalid；一条都不认识 → json-empty；
 * 单条有问题只进 warnings，其余照常导入。
 */
export async function opImport(runtime, payload) {
  const scope = payload?.scope === PROJECT_SCOPE ? PROJECT_SCOPE : GLOBAL_SCOPE
  const file = fileForScope(runtime, scope, payload?.dir)
  const text = typeof payload?.text === 'string' ? payload.text : ''
  if (text.trim() === '') return fail('json-empty', 'JSON 内容为空')

  let parsed
  try {
    parsed = parseMcpJson(text)
  } catch (error) {
    return fail('json-invalid', errorText(error), { text: errorText(error) })
  }
  if (parsed.servers.length === 0) {
    return fail('json-empty', '这份 JSON 里没有解析出任何 MCP 服务器', { warnings: parsed.warnings })
  }

  const read = await readServersFile(file)
  if (read.status === 'invalid' && payload?.overwrite !== true) {
    return fail('file-invalid', `${file} 解析失败，先修复或选择覆盖`, { file, error: read.error })
  }
  const list = read.status === 'invalid' ? [] : read.servers
  const replace = payload?.replace === true
  const dryRun = payload?.dryRun === true
  const imported = []
  const replaced = []
  const skipped = []

  for (const server of parsed.servers) {
    const index = list.findIndex((item) => item.name === server.name)
    if (index !== -1) {
      if (!replace) {
        skipped.push({ name: server.name, reason: 'duplicate-name' })
        continue
      }
      list[index] = server
      replaced.push(server.name)
      continue
    }
    list.push(server)
    imported.push(server.name)
  }

  const value = {
    file,
    scope,
    shape: parsed.shape,
    count: parsed.servers.length,
    imported,
    replaced,
    skipped,
    warnings: parsed.warnings,
    preview: parsed.servers,
    dryRun,
  }
  if (dryRun) return ok(value)
  if (imported.length === 0 && replaced.length === 0) return ok({ ...value, written: false })

  const header = scope === GLOBAL_SCOPE ? GLOBAL_FILE_HEADER : PROJECT_FILE_HEADER
  await writeServersFile(file, list, header)
  await resync(runtime, scope, payload?.dir)
  return ok({ ...value, written: true })
}

export async function opRemove(runtime, payload) {
  const scope = payload?.scope === PROJECT_SCOPE ? PROJECT_SCOPE : GLOBAL_SCOPE
  const file = fileForScope(runtime, scope, payload?.dir)
  const name = String(payload?.name ?? '')
  const read = await readServersFile(file)
  if (read.status === 'invalid' || read.status === 'missing') {
    return fail('file-unavailable', `读不到 ${file}`)
  }
  const list = read.servers.filter((item) => item.name !== name)
  if (list.length === read.servers.length) return fail('not-found', `找不到 "${name}"`)
  await writeServersFile(file, list, scope === GLOBAL_SCOPE ? GLOBAL_FILE_HEADER : PROJECT_FILE_HEADER)
  await resync(runtime, scope, payload?.dir)
  return ok({ removed: name })
}

export async function opToggle(runtime, payload) {
  const scope = payload?.scope === PROJECT_SCOPE ? PROJECT_SCOPE : GLOBAL_SCOPE
  const file = fileForScope(runtime, scope, payload?.dir)
  const name = String(payload?.name ?? '')
  const enabled = payload?.enabled === true
  const read = await readServersFile(file)
  if (read.status !== 'ok') return fail('file-unavailable', `读不到 ${file}`)
  const list = read.servers.map((item) => (item.name === name ? { ...item, enabled } : item))
  if (!list.some((item) => item.name === name)) return fail('not-found', `找不到 "${name}"`)
  await writeServersFile(file, list, scope === GLOBAL_SCOPE ? GLOBAL_FILE_HEADER : PROJECT_FILE_HEADER)
  await resync(runtime, scope, payload?.dir)
  return ok({ name, enabled })
}

export async function opInit(runtime, payload) {
  const scope = payload?.scope === PROJECT_SCOPE ? PROJECT_SCOPE : GLOBAL_SCOPE
  const file = fileForScope(runtime, scope, payload?.dir)
  if (!existsSync(file)) {
    const header = scope === GLOBAL_SCOPE ? GLOBAL_FILE_HEADER : PROJECT_FILE_HEADER
    await writeServersFile(file, [], header)
  }
  await resync(runtime, scope, payload?.dir)
  return ok({ file })
}

export async function opMigrate(runtime) {
  const { rows, header } = await readPatchRows(runtime.paths.patchFile)
  const found = collectPatchMcpRows(rows)
  if (found.length === 0) return ok({ migrated: 0, names: [] })
  const read = await readServersFile(runtime.paths.globalFile)
  const existing = read.status === 'invalid' ? [] : read.servers
  const names = new Set(existing.map((item) => item.name))
  const migrated = []
  for (const item of found) {
    const normalized = normalizeServerRow(item.row, 0)
    if (normalized.error !== undefined) continue
    if (names.has(normalized.server.name)) continue
    names.add(normalized.server.name)
    existing.push(normalized.server)
    migrated.push(normalized.server.name)
  }
  await writeServersFile(runtime.paths.globalFile, existing, GLOBAL_FILE_HEADER)
  removePatchMcpRows(rows, found)
  await writePatchRows(runtime.paths.patchFile, rows, header)
  // 旧实例由补丁更新拆掉；给它一点时间再挂，避免 serverName 冲突
  await new Promise((r) => setTimeout(r, 900))
  try {
    await runtime.syncGlobal()
  } catch {
    /* 补丁更新可能顺手把本插件重启了，下一次 apply 会自己挂上 */
  }
  return ok({ migrated: migrated.length, names: migrated, file: runtime.paths.globalFile })
}

export async function opReload(runtime, payload) {
  await runtime.syncGlobal()
  if (payload?.dir !== undefined) {
    const dir = resolve(String(payload.dir))
    for (const agent of runtime.liveAgents()) {
      if (!samePath(runtime.projectDirOf(agent), dir)) continue
      await runtime.syncAgent(agent)
    }
  } else {
    runtime.syncAllAgents()
  }
  return opState(runtime, payload)
}

export async function resync(runtime, scope, dir) {
  if (scope === GLOBAL_SCOPE) {
    await runtime.syncGlobal()
    return
  }
  const projectDir = typeof dir === 'string' && dir.trim() !== '' ? resolve(dir.trim()) : guessProjectDir(runtime)
  for (const agent of runtime.liveAgents()) {
    if (runtime.projectDirOf(agent) !== projectDir) continue
    await runtime.syncAgent(agent)
  }
}

// ── 分发 ────────────────────────────────────────────────────────────────────
export async function dispatch(runtime, action, data) {
  switch (action) {
    case 'state': return opState(runtime, data ?? {})
    case 'save': return opSave(runtime, data ?? {})
    case 'remove': return opRemove(runtime, data ?? {})
    case 'toggle': return opToggle(runtime, data ?? {})
    case 'init': return opInit(runtime, data ?? {})
    case 'import': return opImport(runtime, data ?? {})
    case 'migrate': return opMigrate(runtime)
    case 'reload': return opReload(runtime, data ?? {})
    case 'probe': return ok(await probeServer(data?.server ?? {}))
    default: return fail('unknown-endpoint', `Unknown action ${String(action)}`)
  }
}

export async function readClientRequest(request) {
  let body
  try {
    body = await request.json()
  } catch {
    return undefined
  }
  if (body?.type !== 'client-request' || typeof body.rpcId !== 'string') return undefined
  return { rpcId: body.rpcId, action: body.payload?.action, data: body.payload?.data }
}
