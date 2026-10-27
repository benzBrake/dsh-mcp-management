/**
 * 生成行为基线快照：用 2.0.0 的单文件实现跑一遍 tests/parity-cases.mjs 里的全部输入，
 * 把结果固化到 tests/fixtures/parity-2.0.0.json。
 *
 * 之后 tests/parity.test.mjs 只依赖这份快照，不再 import 旧实现 —— archive/ 因此可以删。
 * 重新生成需要一份 2.0.0 的 lib/index.js：
 *
 *   node scripts/snapshot-parity.mjs <path-to-2.0.0/lib/index.js>
 *   # 例：node scripts/snapshot-parity.mjs D:/work/ida-env/plugins/dsh-mcp-presets/lib/index.js
 *
 * 注意：旧实现必须是 2.0.0（`export const name = 'mcp-presets'`，单文件约 1200 行）。
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  buildPatchRows,
  dispatchCase,
  entryRowCases,
  normalizeReadResult,
  normalizeRowCases,
  resolvePathsCases,
  serversFileSamples,
  withHomePlaceholder,
  writeServersCase,
} from '../tests/parity-cases.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const target = resolve(process.argv[2] ?? '')
if (!process.argv[2]) {
  console.error('用法: node scripts/snapshot-parity.mjs <path-to-2.0.0/lib/index.js>')
  process.exit(2)
}

const legacy = await import(pathToFileURL(target).href)
if (legacy.name !== 'mcp-presets' || typeof legacy.__internals !== 'object') {
  console.error(`不像是 2.0.0 的实现：name=${legacy.name}（期望 mcp-presets），且需要有 __internals`)
  process.exit(2)
}

const ref = legacy.__internals
const snapshot = {
  generatedFrom: 'dsh-mcp-presets 2.0.0 · lib/index.js（单文件实现）',
  generatedBy: 'scripts/snapshot-parity.mjs',
  shape: {
    name: legacy.name,
    inject: legacy.inject,
    internals: Object.keys(ref).sort(),
  },
  resolvePaths: resolvePathsCases.map((config) => ({ config, expected: withHomePlaceholder(ref.resolvePaths(config)) })),
  normalizeServerRow: normalizeRowCases.map((row, index) => ({
    row: row === undefined ? null : row,
    expected: ref.normalizeServerRow(row, index),
  })),
  toEntryRow: entryRowCases.map((server) => ({ server, expected: ref.toEntryRow(server) })),
  readServersFile: [],
  writeServersFile: undefined,
  patchRows: undefined,
  dispatch: undefined,
}

// readServersFile：每种状态一份输入 + 归一化后的期望结果
const dir = mkdtempSync(join(tmpdir(), 'dsh-parity-snapshot-'))
try {
  for (const [name, text] of Object.entries(serversFileSamples)) {
    const file = join(dir, name)
    if (text !== undefined) writeFileSync(file, text, 'utf8')
    const actual = await ref.readServersFile(file)
    snapshot.readServersFile.push({ name, text: text ?? null, expected: normalizeReadResult(actual, dir) })
  }

  // writeServersFile：两次写入 + .bak 的字节内容
  const header = writeServersCase.header
  const servers = writeServersCase.servers
  const first = join(dir, 'write', 'mcp.yml')
  await ref.writeServersFile(first, servers, header)
  const afterFirst = readFileSync(first, 'utf8')
  await ref.writeServersFile(first, servers.slice(0, writeServersCase.pruneTo), header)
  snapshot.writeServersFile = {
    header,
    servers,
    pruneTo: writeServersCase.pruneTo,
    afterFirst,
    afterSecond: readFileSync(first, 'utf8'),
    bak: readFileSync(`${first}.bak`, 'utf8'),
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// patch 行：collect 的下标 + remove 之后的完整结构
{
  const rows = buildPatchRows()
  const found = ref.collectPatchMcpRows(rows)
  const foundLite = found.map((item) => [item.index, item.row?.config?.serverName ?? null])
  ref.removePatchMcpRows(rows, found)
  snapshot.patchRows = { rows: buildPatchRows(), found: foundLite, afterRemove: rows }
}

// dispatch：未知 action 的 envelope
snapshot.dispatch = { action: dispatchCase.action, expected: await ref.dispatch({}, dispatchCase.action, dispatchCase.data) }

const outPath = join(root, 'tests', 'fixtures', 'parity-2.0.0.json')
mkdirSync(join(root, 'tests', 'fixtures'), { recursive: true })
writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')

const bytes = readFileSync(outPath).length
console.log(`已生成 ${outPath}（${bytes} 字节）`)
console.log(`来源：${target}`)
console.log(`用例：resolvePaths ${snapshot.resolvePaths.length} · normalize ${snapshot.normalizeServerRow.length} · entry ${snapshot.toEntryRow.length} · 文件状态 ${snapshot.readServersFile.length}`)
