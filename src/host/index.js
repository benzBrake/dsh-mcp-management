/**
 * dsh-mcp-management — 宿主入口（plugin entry）。
 *
 * 这里只做装配：解析路径 → 建 runtime → 接事件 → 注册 RPC 通道。
 * 具体实现分散在：
 *   paths.js    三个配置文件的路径解析
 *   servers.js  mcp.yml 的读 / 规范化 / 写
 *   import.js   别人给的 MCP JSON → server 对象（面板的「导入 JSON」）
 *   entries.js  「服务器 → loader 行」，以及内存 EntryTree
 *   runtime.js  全局 + 每会话挂载、文件热更新、调试快照
 *   migrate.js  旧 cordis.patch.yml 顶层 mcp-client 行的识别与摘除
 *   probe.js    「测试」按钮的真连通探测
 *   rpc.js      /api/mcp-management 的动作实现与分发
 *
 * 挂载模型见 docs/architecture.md；面板行为见 README.md。
 */

import { PLUGIN_NAME, RPC_PATH } from './constants.js'
import { toEntryRow } from './entries.js'
import { parseMcpJson } from './import.js'
import { collectPatchMcpRows, removePatchMcpRows } from './migrate.js'
import { resolvePaths } from './paths.js'
import { probeServer } from './probe.js'
import { dispatch, fail, readClientRequest } from './rpc.js'
import { createRuntime } from './runtime.js'
import { normalizeServerRow, readServersFile, writeServersFile } from './servers.js'
import { errorText } from './util.js'

export const name = PLUGIN_NAME
export const inject = ['connection', 'loader']

/** 只给测试 / 排错用：不做任何副作用，重复 import 安全。 */
export const __internals = {
  readServersFile,
  writeServersFile,
  normalizeServerRow,
  parseMcpJson,
  toEntryRow,
  collectPatchMcpRows,
  removePatchMcpRows,
  resolvePaths,
  probeServer,
  dispatch,
  createRuntime,
}

export function apply(ctx, rawConfig) {
  const paths = resolvePaths(rawConfig)
  const logger = ctx.logger(name)
  const runtime = createRuntime(ctx, paths, logger)

  ctx.effect(() => () => runtime.close(), `${name}: runtime`)

  ctx.on('agent/created', ({ agent }) => {
    try {
      const pending = runtime.syncAgent(agent)
      // 不在创建阶段卡住会话：最多等 1.2s，连上了就顺手赶上第一轮。
      return Promise.race([pending.catch(() => undefined), new Promise((r) => setTimeout(r, 1200))])
    } catch (error) {
      logger.warn(`项目 MCP 挂载失败：${errorText(error)}`)
      return undefined
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    runtime.dropAgent(agent.id)
  })

  ctx.inject(['agents'], () => {
    runtime.syncAllAgents()
  })

  void runtime.syncGlobal().catch((error) => logger.warn(`全局 MCP 同步失败：${errorText(error)}`))
  runtime.watchGlobal()
  runtime.syncAllAgents()
  if (paths.debugFile !== '') {
    setTimeout(() => runtime.dump('boot'), 1500).unref?.()
    setTimeout(() => runtime.dump('boot+'), 4000).unref?.()
  }

  ctx.inject(['connection'], (rpcCtx) => {
    rpcCtx.effect(() => {
      const dispose = rpcCtx.connection.fetch.register({
        path: RPC_PATH,
        methods: ['POST'],
        fetch: async (request) => {
          const envelope = await readClientRequest(request)
          if (envelope === undefined) return new Response('invalid client-request envelope', { status: 400 })
          let result
          try {
            result = typeof envelope.action === 'string'
              ? await dispatch(runtime, envelope.action, envelope.data)
              : fail('unknown-endpoint', 'Missing action')
          } catch (error) {
            result = fail('internal', errorText(error))
          }
          return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result })
        },
      })
      return () => {
        void dispose()
      }
    }, `${name}: rpc channel`)
  })

  logger.info('%s active (global: %s, project: %s)', name, paths.globalFile, paths.projectFile)
}
