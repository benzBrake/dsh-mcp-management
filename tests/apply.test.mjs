/**
 * 装配测试：用一个假 ctx 把 apply() 真跑一遍，验证插件入口的接线。
 *
 * 这里故意不提供 loader（没有 EntryTree），所以任何挂载动作都会失败并被吞进
 * mountError —— 正是插件该有的降级行为。检查点：
 *   - apply 不抛（失败只在 logger.warn / state.mountError 里）
 *   - POST /api/mcp-management 的路径与信封格式正确
 *   - state 能读、save 能落盘、dispose 能干净关掉 runtime
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../src/host/index.js'

function fakeHost() {
  const cleanups = []
  const handlers = new Map()
  const warnings = []
  let rpc = undefined

  const logger = () => ({
    info: () => {},
    warn: (message) => warnings.push(String(message)),
    debug: () => {},
    error: (message) => warnings.push(String(message)),
  })

  const rpcCtx = {
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return dispose
    },
    connection: {
      fetch: {
        register: (options) => {
          rpc = options
          return async () => {}
        },
      },
    },
  }

  const ctx = {
    baseUrl: 'file:///fake/',
    logger,
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return dispose
    },
    on: (event, fn) => {
      handlers.set(event, fn)
    },
    inject: (deps, fn) => {
      if (deps.includes('connection')) fn(rpcCtx)
      if (deps.includes('agents')) fn(ctx)
      return () => {}
    },
    get: () => undefined,
  }

  return {
    ctx,
    warnings,
    handlers,
    get rpc() {
      return rpc
    },
    disposeAll() {
      for (const cleanup of cleanups.reverse()) cleanup()
    },
  }
}

async function callRpc(rpc, payload) {
  const res = await rpc.fetch({
    json: async () => ({ type: 'client-request', rpcId: 'rpc-1', payload }),
  })
  const body = await res.json()
  assert.equal(body.type, 'server-response')
  assert.equal(body.rpcId, 'rpc-1')
  return body.result
}

test('apply: 没有 loader 也能起来，RPC 通道按约定路径注册', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mcp-management-apply-'))
  const host = fakeHost()
  try {
    apply(host.ctx, { profileDir: root })
    assert.equal(host.rpc.path, '/api/mcp-management')
    assert.deepEqual(host.rpc.methods, ['POST'])
    assert.equal(typeof host.rpc.fetch, 'function')
    assert.deepEqual([...host.handlers.keys()].sort(), ['agent/created', 'agent/disposed'])

    const state = await callRpc(host.rpc, { action: 'state' })
    assert.equal(state.ok, true)
    assert.equal(state.value.global.status, 'missing')
    assert.equal(state.value.global.file, join(root, 'mcp.yml'))

    const saved = await callRpc(host.rpc, {
      action: 'save',
      data: { scope: 'global', server: { name: 'ida', transport: 'stdio', command: 'x.exe' } },
    })
    assert.equal(saved.ok, true)
    assert.equal(readFileSync(join(root, 'mcp.yml'), 'utf8').includes('name: ida'), true)

    // 没有 loader → 挂载失败必须写进 mountError，而不是抛给调用方
    const after = await callRpc(host.rpc, { action: 'state' })
    assert.equal(after.value.global.servers.length, 1)
    assert.equal(typeof after.value.global.mountError, 'string')
    assert.ok(host.warnings.some((line) => line.includes('MCP 挂载失败')), host.warnings.join('\n'))

    // 「导入 JSON」走的是同一条 RPC 通道：dryRun 不写，正式导入写
    const mcpJson = JSON.stringify({ mcpServers: { web: { url: 'https://example.test/mcp' } } })
    const preview = await callRpc(host.rpc, { action: 'import', data: { scope: 'global', text: mcpJson, dryRun: true } })
    assert.equal(preview.ok, true)
    assert.deepEqual(preview.value.preview.map((s) => s.name), ['web'])
    assert.equal(readFileSync(join(root, 'mcp.yml'), 'utf8').includes('name: web'), false)

    const imported = await callRpc(host.rpc, { action: 'import', data: { scope: 'global', text: mcpJson } })
    assert.equal(imported.ok, true)
    assert.deepEqual(imported.value.imported, ['web'])
    assert.equal(readFileSync(join(root, 'mcp.yml'), 'utf8').includes('name: web'), true)

    const unknown = await callRpc(host.rpc, { action: 'nope' })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'unknown-endpoint')
  } finally {
    host.disposeAll()
    rmSync(root, { recursive: true, force: true })
  }
})

test('apply: 空信封直接 400，不碰 runtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mcp-management-apply-'))
  const host = fakeHost()
  try {
    apply(host.ctx, { profileDir: root })
    const res = await host.rpc.fetch({ json: async () => ({ hello: 'world' }) })
    assert.equal(res.status, 400)
    assert.equal(await res.text(), 'invalid client-request envelope')
  } finally {
    host.disposeAll()
    rmSync(root, { recursive: true, force: true })
  }
})
