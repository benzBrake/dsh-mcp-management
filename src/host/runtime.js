/**
 * 运行时：全局挂载 + 每会话的项目挂载 + 文件热更新。
 *
 * 全局清单 → 挂在本插件自己的 root 作用域（等价于 profile 补丁里的一条顶层
 * mcp-client 行）；项目清单 → 挂进**该会话自己的 Agent 作用域**，所以 A 项目的
 * 会话看不见 B 项目的 MCP，也不需要“切项目时把别人的条目 disabled”那种合成补丁。
 *
 * 代价写在这里，避免以后当 bug 修：同一个项目开着 N 个会话，就是 N 份 MCP 子进程。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { createTree, stopTree, toEntryRow, updateWithRetry } from './entries.js'
import { samePath } from './paths.js'
import { readServersFile } from './servers.js'
import { errorText } from './util.js'

/** 全局挂载 + 每个会话的项目挂载 + 文件监视。 */
export function createRuntime(ctx, paths, logger) {
  const runtime = {
    ctx,
    paths,
    global: { tree: undefined, file: paths.globalFile, status: 'missing', servers: [], error: undefined, warnings: [], mountError: undefined, ready: false },
    agents: new Map(),
    watchers: new Map(),
    timers: new Map(),
    closed: false,
    lastDumpAt: 0,
  }

  const baseUrl = ctx.baseUrl

  /** 调试：把面板看到的状态写到 debugFile（排查"为什么没挂上"用）。 */
  function dumpState(reason) {
    if (typeof paths.debugFile !== 'string' || paths.debugFile === '') return
    const now = Date.now()
    if (now - runtime.lastDumpAt < 150) return
    runtime.lastDumpAt = now
    try {
      const snapshot = {
        at: new Date(now).toISOString(),
        reason,
        paths: runtime.paths,
        global: {
          file: runtime.global.file,
          status: runtime.global.status,
          servers: runtime.global.servers.map((s) => s.name),
          mountError: runtime.global.mountError,
          tree: runtime.global.tree !== undefined,
          visibleTools: (() => {
            try {
              const tools = ctx.get('tools')
              if (tools === undefined) return []
              return [...tools.view(undefined).visible.keys()].filter((name) => name.startsWith('mcp__'))
            } catch {
              return []
            }
          })(),
        },
        agents: [...runtime.agents.entries()].map(([id, state]) => ({
          id,
          dir: state.dir,
          file: state.file,
          status: state.status,
          servers: state.servers.map((s) => s.name),
          mountError: state.mountError,
          tree: state.tree !== undefined,
          visibleTools: (() => {
            const agent = liveAgents().find((item) => item.id === id)
            return agent === undefined ? [] : mcpToolsFor(agent)
          })(),
          entries: state.tree === undefined ? [] : [...state.tree.entries()].map((entry) => ({
            id: entry.id,
            name: entry.options.name,
            fiber: entry.fiber === undefined ? 'none' : entry.fiber.state,
            disabled: entry.disabled,
          })),
        })),
      }
      mkdirSync(dirname(paths.debugFile), { recursive: true })
      writeFileSync(paths.debugFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    } catch {
      /* 调试输出失败不影响主流程 */
    }
  }

  function projectFileOf(dir) {
    return join(dir, paths.projectFile)
  }

  function projectDirOf(agent) {
    try {
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory !== undefined) return workingDirectory.get(agent.session)
    } catch {
      /* 服务不在或会话已销毁 */
    }
    try {
      const cwd = agent.session?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') return cwd
    } catch {
      /* ignore */
    }
    return undefined
  }

  function liveAgents() {
    try {
      const agents = ctx.get('agents')
      if (agents === undefined) return []
      const list = agents.list?.() ?? []
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  /** dsh-scope 的 scope tag（Symbol("dsh.scope")），用于读取该会话可见的工具。 */
  function scopeKeyOf(scopedCtx) {
    try {
      for (const symbol of Object.getOwnPropertySymbols(scopedCtx)) {
        if (symbol.description === 'dsh.scope') return scopedCtx[symbol]
      }
    } catch {
      /* ignore */
    }
    return undefined
  }

  function mcpToolsFor(agent) {
    try {
      const tools = ctx.get('tools')
      const key = scopeKeyOf(agent.ctx)
      if (tools === undefined || key === undefined) return []
      const view = tools.view(key)
      return [...view.visible.keys()].filter((name) => name.startsWith('mcp__'))
    } catch {
      return []
    }
  }

  async function syncGlobal() {
    if (runtime.closed) return
    const read = await readServersFile(paths.globalFile)
    runtime.global.file = read.file
    runtime.global.status = read.status
    runtime.global.servers = read.servers
    runtime.global.warnings = read.warnings
    runtime.global.error = read.error
    if (read.status === 'invalid') {
      // 坏文件不动正在跑的挂载，避免一个手抖把可用的 MCP 全掐了。
      dumpState('global-invalid')
      return
    }
    const rows = read.servers.map(toEntryRow)
    try {
      if (runtime.global.tree === undefined) {
        if (rows.length === 0) {
          runtime.global.mountError = undefined
          dumpState('global-empty')
          return
        }
        runtime.global.tree = createTree(ctx, baseUrl)
      }
      await updateWithRetry(runtime.global.tree, rows)
      runtime.global.mountError = undefined
      runtime.global.ready = true
    } catch (error) {
      runtime.global.mountError = errorText(error)
      logger?.warn?.(`全局 MCP 挂载失败：${runtime.global.mountError}`)
      if (rows.length === 0) {
        stopTree(runtime.global.tree)
        runtime.global.tree = undefined
      }
    }
    dumpState('global')
  }

  function agentStateOf(agent) {
    const dir = projectDirOf(agent)
    if (dir === undefined) return undefined
    let state = runtime.agents.get(agent.id)
    if (state === undefined) {
      state = { dir, file: projectFileOf(dir), status: 'missing', servers: [], warnings: [], error: undefined, mountError: undefined, tree: undefined }
      runtime.agents.set(agent.id, state)
    }
    return state
  }

  async function syncAgent(agent) {
    if (runtime.closed) return
    const state = agentStateOf(agent)
    if (state === undefined) return
    const read = await readServersFile(state.file)
    state.file = read.file
    state.status = read.status
    state.servers = read.servers
    state.warnings = read.warnings
    state.error = read.error
    if (read.status === 'invalid') {
      dumpState('agent-invalid')
      return
    }
    const rows = read.servers.map(toEntryRow)
    if (rows.length === 0) {
      stopTree(state.tree)
      state.tree = undefined
      state.mountError = undefined
      dumpState('agent-empty')
      return
    }
    try {
      const tree = state.tree ?? createTree(agent.ctx, agent.ctx.baseUrl ?? baseUrl)
      state.tree = tree
      await updateWithRetry(tree, rows)
      state.mountError = undefined
      watchProjectFile(state.dir)
    } catch (error) {
      state.mountError = errorText(error)
      logger?.warn?.(`项目 MCP 挂载失败（${state.dir}）：${state.mountError}`)
    }
    dumpState('agent')
  }

  function dropAgent(agentId) {
    const state = runtime.agents.get(agentId)
    if (state === undefined) return
    stopTree(state.tree)
    runtime.agents.delete(agentId)
  }

  function syncAllAgents() {
    for (const agent of liveAgents()) {
      void syncAgent(agent).catch((error) => logger?.warn?.(`项目 MCP 同步失败：${errorText(error)}`))
    }
  }

  // 文件热更新：改文件立刻生效（坏文件保留上一份可用挂载）
  function watchFile(file, label, onChange) {
    if (runtime.watchers.has(file)) return
    runtime.watchers.set(file, undefined)
    import('node:fs').then((fs) => {
      if (runtime.closed || !runtime.watchers.has(file)) return
      try {
        const watcher = fs.watchFile(file, { interval: 900 }, () => {
          const timer = runtime.timers.get(file)
          if (timer !== undefined) clearTimeout(timer)
          runtime.timers.set(
            file,
            setTimeout(() => {
              runtime.timers.delete(file)
              void onChange(label)
            }, 250),
          )
        })
        runtime.watchers.set(file, watcher)
      } catch {
        runtime.watchers.delete(file)
      }
    })
  }

  function unwatchAll() {
    import('node:fs').then((fs) => {
      for (const [file, watcher] of runtime.watchers) {
        if (watcher === undefined) continue
        try {
          fs.unwatchFile(file, watcher)
        } catch {
          /* ignore */
        }
      }
      runtime.watchers.clear()
    })
    for (const timer of runtime.timers.values()) clearTimeout(timer)
    runtime.timers.clear()
  }

  function watchProjectFile(dir) {
    watchFile(projectFileOf(dir), `project:${dir}`, () => {
      for (const [agentId, state] of runtime.agents) {
        if (!samePath(state.dir, dir)) continue
        const agent = liveAgents().find((a) => a.id === agentId)
        if (agent === undefined) {
          dropAgent(agentId)
          continue
        }
        void syncAgent(agent)
      }
    })
  }

  return {
    runtime,
    paths,
    syncGlobal,
    syncAgent,
    syncAllAgents,
    dropAgent,
    projectDirOf,
    projectFileOf,
    liveAgents,
    dump: dumpState,
    watchGlobal: () => watchFile(paths.globalFile, 'global', () => void syncGlobal()),
    watchProjectFile,
    close() {
      runtime.closed = true
      unwatchAll()
      stopTree(runtime.global.tree)
      runtime.global.tree = undefined
      for (const id of [...runtime.agents.keys()]) dropAgent(id)
    },
  }
}
