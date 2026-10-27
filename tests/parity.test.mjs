/**
 * 行为基线测试：新实现 vs tests/fixtures/parity-2.0.0.json
 *
 * 快照由 2.0.0 的单文件实现生成（scripts/snapshot-parity.mjs），所以这里不需要
 * 旧实现的源码 —— archive/ 可以删，基线仍然在（16 KB 的 JSON）。
 *
 * 覆盖：纯函数（resolvePaths / normalizeServerRow / toEntryRow / patch 行收集）、
 * 文件 IO（readServersFile 四态、writeServersFile 落盘字节与 .bak）、未知 action 的 envelope。
 *
 * 用例数据在 tests/parity-cases.mjs，快照生成脚本共用同一份。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildPatchRows,
  dispatchCase,
  entryRowCases,
  normalizeReadResult,
  normalizeRowCases,
  resolvePathsCases,
  serversFileSamples,
  withHomePlaceholder,
} from './parity-cases.mjs'
import { collectPatchMcpRows, removePatchMcpRows } from '../src/host/migrate.js'
import { toEntryRow } from '../src/host/entries.js'
import { dispatch } from '../src/host/rpc.js'
import { normalizeServerRow, readServersFile, writeServersFile } from '../src/host/servers.js'
import { resolvePaths } from '../src/host/paths.js'

const snapshot = JSON.parse(readFileSync(new URL('./fixtures/parity-2.0.0.json', import.meta.url), 'utf8'))

test('快照与用例数量一致（新增用例后要重生成快照）', () => {
  assert.equal(snapshot.resolvePaths.length, resolvePathsCases.length)
  assert.equal(snapshot.normalizeServerRow.length, normalizeRowCases.length)
  assert.equal(snapshot.toEntryRow.length, entryRowCases.length)
  assert.equal(snapshot.readServersFile.length, Object.keys(serversFileSamples).length)
  assert.equal(snapshot.shape.name, 'mcp-presets', '快照应来自 2.0.0；若是新名说明生成源选错了')
})

test('公开形状：inject 与 __internals 键与快照一致（插件名是显式变更）', async () => {
  const host = await import('../src/host/index.js')
  // 显式新增：JSON 导入的解析器（只加不改，别顺手删别的键）
  const ADDED_INTERNALS = ['parseMcpJson']
  assert.equal(host.name, 'mcp-management')
  assert.deepEqual(host.inject, snapshot.shape.inject)
  assert.deepEqual(Object.keys(host.__internals).sort(), [...snapshot.shape.internals, ...ADDED_INTERNALS].sort())
  assert.equal(typeof host.apply, 'function')
})

test('resolvePaths: 各种配置组合与基线一致', () => {
  // 默认路径来自 home 目录，快照里存的是 <HOME> 占位，两侧各归一化一次
  for (const { config, expected } of snapshot.resolvePaths) {
    assert.deepEqual(withHomePlaceholder(resolvePaths(config)), expected, JSON.stringify(config))
  }
})

test('normalizeServerRow: 简洁写法、cordis 行写法、坏条目与基线一致', () => {
  snapshot.normalizeServerRow.forEach(({ row, expected }, index) => {
    assert.deepEqual(normalizeServerRow(row, index), expected, `row ${index}`)
  })
})

test('toEntryRow: loader 行结构（含 disabled 与 entryId 净化）与基线一致', () => {
  for (const { server, expected } of snapshot.toEntryRow) {
    assert.deepEqual(toEntryRow(server), expected, server.name)
  }
})

test('readServersFile: missing / empty / ok / invalid 四态与基线一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-parity-read-'))
  try {
    for (const { name, text, expected } of snapshot.readServersFile) {
      const file = join(dir, name)
      if (text !== null) writeFileSync(file, text, 'utf8')
      const actual = normalizeReadResult(await readServersFile(file), dir)
      assert.deepEqual(actual, expected, name)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeServersFile: 落盘内容与 .bak 与基线逐字节一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-parity-write-'))
  try {
    const first = join(dir, 'write', 'mcp.yml')
    const { header, servers, pruneTo, afterFirst, afterSecond, bak } = snapshot.writeServersFile
    await writeServersFile(first, servers, header)
    assert.equal(readFileSync(first, 'utf8'), afterFirst)
    await writeServersFile(first, servers.slice(0, pruneTo), header)
    assert.equal(readFileSync(first, 'utf8'), afterSecond)
    assert.equal(readFileSync(`${first}.bak`, 'utf8'), bak)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('patch 行：collect 的下标与 remove 的结果与基线一致', () => {
  const rows = buildPatchRows()
  const found = collectPatchMcpRows(rows)
  assert.deepEqual(
    found.map((item) => [item.index, item.row?.config?.serverName ?? null]),
    snapshot.patchRows.found,
  )
  removePatchMcpRows(rows, found)
  assert.deepEqual(rows, snapshot.patchRows.afterRemove)
})

test('dispatch: 未知 action 的 envelope 与基线一致', async () => {
  assert.deepEqual(await dispatch({}, dispatchCase.action, dispatchCase.data), snapshot.dispatch.expected)
})
