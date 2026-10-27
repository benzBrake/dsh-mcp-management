/**
 * 静态自检：包声明、补丁行、浏览器模块 id、宿主入口是否互相咬合。
 *
 * 这个插件的三个名字必须始终一致，否则表现是「面板不见了」而报错信息完全不给线索：
 *   package.json  name            —— pnpm link 的目录名
 *   cordis.patch.yml  insert.name —— Loader 去 node_modules 找的包名
 *   client.js  load({ id })       —— 浏览器 ModuleLoader 注册的模块 id
 * 另外 PLUGIN_VERSION 必须与 package.json 的 version 一致（探测请求会带出去）。
 *
 * 跑法：npm run check
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const pkg = JSON.parse(read('package.json'))
const patch = read('cordis.patch.yml')
const client = read('src/client/client.js')
const constants = read('src/host/constants.js')

// 1. 入口文件都在
for (const rel of [pkg.main, pkg.exports['.'].default, pkg.exports['./client'].default, pkg.dsh.bundle.patch]) {
  assert.ok(existsSync(join(root, rel)), `入口文件缺失：${rel}`)
}
assert.ok(pkg.files.includes('src'), 'package.json 的 files 里要带上 src')

// 2. 三个名字 + 版本一致
assert.equal(pkg.name, 'dsh-mcp-management')
assert.match(patch, /^\s*- id: mcp-management$/m, 'cordis.patch.yml 缺 insert id')
assert.ok(patch.includes(`name: '${pkg.name}'`), 'cordis.patch.yml 的 insert name 与包名不一致')
assert.ok(client.includes(`id: "${pkg.name}"`), 'client.js 的 ModuleLoader id 与包名不一致')
assert.ok(constants.includes(`PLUGIN_VERSION = '${pkg.version}'`), 'constants.js 的 PLUGIN_VERSION 与 package.json 不一致')

// 3. 浏览器半是单文件工厂，不能出现顶层 ESM import
assert.ok(client.includes('window.__ModuleLoader__.load({'), 'client.js 丢了 ModuleLoader 包装')
assert.doesNotMatch(client, /^\s*import\s/m, 'client.js 不能出现顶层 import：它跑在 ModuleLoader 工厂里')

// 4. 宿主入口的公开形状
const host = await import(pathToFileURL(join(root, pkg.exports['.'].default)).href)
assert.equal(host.name, 'mcp-management')
assert.deepEqual(host.inject, ['connection', 'loader'])
assert.equal(typeof host.apply, 'function')
assert.deepEqual(Object.keys(host.__internals).sort(), [
  'collectPatchMcpRows',
  'createRuntime',
  'dispatch',
  'normalizeServerRow',
  'parseMcpJson',
  'probeServer',
  'readServersFile',
  'removePatchMcpRows',
  'resolvePaths',
  'toEntryRow',
  'writeServersFile',
])

// 5. 行为基线快照：tests/parity.test.mjs 的输入，删了或来源不对就没法证明“重构没改行为”
const fixturePath = join(root, 'tests', 'fixtures', 'parity-2.0.0.json')
assert.ok(existsSync(fixturePath), '行为基线快照不在了：tests/fixtures/parity-2.0.0.json')
const snapshot = JSON.parse(readFileSync(fixturePath, 'utf8'))
assert.equal(snapshot.shape?.name, 'mcp-presets', '行为基线快照应来自 2.0.0（插件名 mcp-presets）')
for (const key of ['resolvePaths', 'normalizeServerRow', 'toEntryRow', 'readServersFile']) {
  assert.ok(Array.isArray(snapshot[key]) && snapshot[key].length > 0, `行为基线快照缺 ${key}`)
}

console.log('check ok：包声明 / 补丁行 / 浏览器模块 id / 版本 / 宿主入口 / 行为基线 全部对得上')
