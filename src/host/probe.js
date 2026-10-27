/**
 * 探测：面板上「测试」按钮的真动作——真起一个进程 / 真发一次 tools/list。
 *
 * SDK 不在本包的 node_modules 里，所以走 importFromProfile（先正常解析，
 * 再退回 <profile>/node_modules）。超时不靠 SDK 自带的，自己包一层 Promise.race，
 * 因为 stdio 服务器卡住时 SDK 的 connect 可能永远不返回。
 */

import { PLUGIN_VERSION } from './constants.js'
import { errorText } from './util.js'
import { importFromProfile } from './yaml.js'

export async function probeServer(server, timeoutMs = 8000) {
  const started = Date.now()
  const finish = (result) => ({ ...result, latencyMs: Date.now() - started })
  let client
  try {
    const { Client } = await importFromProfile(
      '@modelcontextprotocol/sdk/client/index.js',
      '@modelcontextprotocol/sdk/dist/esm/client/index.js',
    )
    client = new Client({ name: 'dsh-mcp-management-probe', version: PLUGIN_VERSION }, { capabilities: {} })
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`探测超时（${timeoutMs}ms）`)), timeoutMs))
    let transport
    if (server.transport === 'stdio') {
      const { StdioClientTransport } = await importFromProfile(
        '@modelcontextprotocol/sdk/client/stdio.js',
        '@modelcontextprotocol/sdk/dist/esm/client/stdio.js',
      )
      transport = new StdioClientTransport({
        command: server.command ?? '',
        args: server.args,
        env: { ...(server.env ?? {}) },
        cwd: server.cwd,
      })
    } else {
      const { StreamableHTTPClientTransport } = await importFromProfile(
        '@modelcontextprotocol/sdk/client/streamableHttp.js',
        '@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js',
      )
      transport = new StreamableHTTPClientTransport(new URL(server.url ?? ''), {
        requestInit: { headers: server.headers ?? {} },
      })
    }
    await Promise.race([client.connect(transport), timeout])
    const tools = await Promise.race([client.listTools(), timeout])
    return finish({ ok: true, toolCount: Array.isArray(tools?.tools) ? tools.tools.length : 0 })
  } catch (error) {
    return finish({ ok: false, error: errorText(error) })
  } finally {
    try {
      await client?.close()
    } catch {
      /* ignore */
    }
  }
}
