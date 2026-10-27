/**
 * 「粘贴 JSON 导入」的测试：宽松解析 + 外层形状兼容 + RPC 落盘。
 *
 * 别人给的 JSON 只有一条铁律：不能信格式。所以用例覆盖了 mcpServers 映射、
 * 服务器数组、数组里塞映射、裸名称映射、单台对象，以及 type/baseUrl/command 数组/
 * args 字符串/env 数组/disabled 这些内层变体，加上代码围栏、注释、尾随逗号。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { dropTrailingCommas, parseMcpJson, stripJsonWrapper } from '../src/host/import.js'
import { dispatch } from '../src/host/rpc.js'
import { readServersFile } from '../src/host/servers.js'

function stubRuntime(root) {
  const projectDir = join(root, 'proj')
  const agent = { id: 'agent-1', status: 'running', session: { header: { cwd: projectDir } } }
  const synced = []
  return {
    paths: {
      profileDir: root,
      globalFile: join(root, 'mcp.yml'),
      projectFile: join('.dsh', 'mcp.yml'),
      patchFile: join(root, 'cordis.patch.yml'),
      debugFile: '',
    },
    runtime: { global: { tree: undefined, mountError: undefined, servers: [] }, agents: new Map(), paths: {} },
    liveAgents: () => [agent],
    projectDirOf: () => projectDir,
    projectFileOf: (dir) => join(dir, '.dsh', 'mcp.yml'),
    syncGlobal: async () => {
      synced.push('global')
    },
    syncAgent: async () => {},
    syncAllAgents: () => {},
    dropAgent: () => {},
    dump: () => {},
    watchGlobal: () => {},
    watchProjectFile: () => {},
    close: () => {},
    projectDir,
    synced,
  }
}

async function inTemp(name, fn) {
  const root = mkdtempSync(join(tmpdir(), `dsh-mcp-import-${name}-`))
  try {
    return await fn(root, stubRuntime(root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const json = (value) => JSON.stringify(value)

// ── 解析 ────────────────────────────────────────────────────────────────────

test('mcpServers 映射：键就是服务器名，env/args 原样带过来', () => {
  const parsed = parseMcpJson(
    json({
      mcpServers: {
        ida: { command: 'D:\\tools\\ida\\idalib-mcp.exe', args: ['--stdio'], env: { IDADIR: 'D:\\tools\\ida' } },
      },
    }),
  )
  assert.equal(parsed.shape, 'mcpServers')
  assert.deepEqual(parsed.servers, [
    { name: 'ida', transport: 'stdio', command: 'D:\\tools\\ida\\idalib-mcp.exe', args: ['--stdio'], env: { IDADIR: 'D:\\tools\\ida' } },
  ])
  assert.deepEqual(parsed.warnings, [])
})

test('数组（[{…}]）：每项一台，name 写在对象里', () => {
  const parsed = parseMcpJson(
    json([
      { name: 'ida', command: 'x.exe', args: ['--stdio'] },
      { name: 'web', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer T' } },
    ]),
  )
  assert.equal(parsed.shape, 'array')
  assert.deepEqual(parsed.servers.map((s) => [s.name, s.transport]), [
    ['ida', 'stdio'],
    ['web', 'streamable-http'],
  ])
})

test('数组里塞映射（[{ name: {…} }]）也认', () => {
  const parsed = parseMcpJson(json([{ web: { url: 'https://example.test/mcp', type: 'http' } }]))
  assert.equal(parsed.servers.length, 1)
  assert.equal(parsed.servers[0].name, 'web')
  assert.equal(parsed.servers[0].transport, 'streamable-http')
})

test('裸名称映射（{ name: {…} }）+ 非法字符清洗', () => {
  const parsed = parseMcpJson(json({ 'my.server': { command: 'npx', args: ['-y', 'some-mcp'] } }))
  assert.equal(parsed.shape, 'map')
  assert.equal(parsed.servers[0].name, 'my_server')
  assert.deepEqual(parsed.servers[0].args, ['-y', 'some-mcp'])
  assert.ok(parsed.warnings.some((line) => line.includes('非法字符')), parsed.warnings.join('\n'))
})

test('单台服务器对象（{ name, url }）', () => {
  const parsed = parseMcpJson(json({ name: 'web', url: 'https://example.test/mcp' }))
  assert.equal(parsed.shape, 'server')
  assert.equal(parsed.servers[0].transport, 'streamable-http')
})

test('内层变体：type:sse / baseUrl / command 数组 / args 字符串 / env 数组 / disabled', () => {
  const parsed = parseMcpJson(
    json({
      mcpServers: {
        remote: { type: 'sse', baseUrl: 'https://example.test/sse' },
        zed: { command: ['npx', '-y', 'some-mcp'], args: '--stdio', env: ['TOKEN=abc', 'X=1'], disabled: true },
      },
    }),
  )
  const remote = parsed.servers.find((s) => s.name === 'remote')
  assert.equal(remote.transport, 'streamable-http')
  assert.equal(remote.url, 'https://example.test/sse')
  assert.ok(parsed.warnings.some((line) => line.includes('SSE')), parsed.warnings.join('\n'))

  const zed = parsed.servers.find((s) => s.name === 'zed')
  assert.equal(zed.command, 'npx')
  assert.deepEqual(zed.args, ['-y', 'some-mcp', '--stdio'])
  assert.deepEqual(zed.env, { TOKEN: 'abc', X: '1' })
  assert.equal(zed.enabled, false)
})

test('cordis 行写法（name: @…/dsh-mcp-client + config）也能导进来', () => {
  const parsed = parseMcpJson(
    json([
      {
        id: 'mcp-ida',
        name: '@deepseek-ai/dsh-mcp-client',
        config: { serverName: 'ida', transport: 'stdio', command: 'x.exe', args: ['--a'] },
      },
    ]),
  )
  assert.deepEqual(parsed.servers, [{ name: 'ida', transport: 'stdio', command: 'x.exe', args: ['--a'] }])
})

test('宽松文本：代码围栏 / 整行注释 / 尾随逗号', () => {
  const text = ['```json', '{', '  // 别人顺手写的备注', '  "mcpServers": {', '    "ida": { "command": "x.exe", },', '  },', '}', '```'].join(
    '\n',
  )
  const parsed = parseMcpJson(text)
  assert.equal(parsed.servers.length, 1)
  assert.equal(parsed.servers[0].name, 'ida')
  assert.ok(parsed.warnings.some((line) => line.includes('尾随逗号')), parsed.warnings.join('\n'))
})

test('stripJsonWrapper / dropTrailingCommas：不动字符串里的逗号与 URL', () => {
  assert.equal(stripJsonWrapper('\uFEFF  ```json\n{"a":1}\n```  '), '{"a":1}')
  assert.equal(stripJsonWrapper('// x\n{"a":1}'), '{"a":1}')
  const raw = '{"args":["--flag,]", "--b"], "url":"https://e.test/a,",}'
  const fixed = dropTrailingCommas(raw)
  assert.equal(fixed, '{"args":["--flag,]", "--b"], "url":"https://e.test/a,"}')
  assert.doesNotThrow(() => JSON.parse(fixed))
})

test('整段不是 JSON → 抛错（rpc 层转 json-invalid）', () => {
  assert.throws(() => parseMcpJson('npx -y some-mcp'), /JSON 解析失败/)
  assert.throws(() => parseMcpJson('   '), /内容为空/)
})

test('同一份里名称重复：只留第一条并给出提示', () => {
  const parsed = parseMcpJson(json([{ name: 'a', command: '1.exe' }, { name: 'a', command: '2.exe' }]))
  assert.equal(parsed.servers.length, 1)
  assert.equal(parsed.servers[0].command, '1.exe')
  assert.ok(parsed.warnings.some((line) => line.includes('重复')), parsed.warnings.join('\n'))
})

// ── RPC ────────────────────────────────────────────────────────────────────

test('import：dryRun 只解析不落盘，正式导入写文件并重挂', async () => {
  await inTemp('rpc', async (root, runtime) => {
    const text = json({ mcpServers: { ida: { command: 'x.exe', args: ['--stdio'] } } })

    const dry = await dispatch(runtime, 'import', { scope: 'global', text, dryRun: true })
    assert.equal(dry.ok, true)
    assert.equal(dry.value.dryRun, true)
    assert.deepEqual(dry.value.imported, ['ida'])
    assert.equal(dry.value.preview[0].name, 'ida')
    assert.equal(existsSync(runtime.paths.globalFile), false, 'dryRun 不能写文件')

    const done = await dispatch(runtime, 'import', { scope: 'global', text })
    assert.equal(done.ok, true)
    assert.equal(done.value.written, true)
    assert.deepEqual(done.value.imported, ['ida'])
    assert.deepEqual(runtime.synced, ['global'])

    const read = await readServersFile(runtime.paths.globalFile)
    assert.equal(read.status, 'ok')
    assert.deepEqual(read.servers[0], { name: 'ida', transport: 'stdio', command: 'x.exe', args: ['--stdio'] })

    // 第二次写同一份文件才产生 .bak（首次是新建文件，没有旧内容可备）
    const again = await dispatch(runtime, 'import', {
      scope: 'global',
      text: json([{ name: 'web', url: 'https://example.test/mcp' }]),
    })
    assert.deepEqual(again.value.imported, ['web'])
    assert.equal(existsSync(`${runtime.paths.globalFile}.bak`), true)
  })
})

test('import：同名默认跳过，replace 才覆盖', async () => {
  await inTemp('dupe', async (root, runtime) => {
    writeFileSync(
      runtime.paths.globalFile,
      ['servers:', '  - name: ida', '    transport: stdio', '    command: old.exe', ''].join('\n'),
      'utf8',
    )
    const before = readFileSync(runtime.paths.globalFile, 'utf8')
    const text = json({ mcpServers: { ida: { command: 'new.exe' } } })

    const skipped = await dispatch(runtime, 'import', { scope: 'global', text })
    assert.equal(skipped.ok, true)
    assert.deepEqual(skipped.value.skipped, [{ name: 'ida', reason: 'duplicate-name' }])
    assert.equal(skipped.value.written, false)
    assert.equal(readFileSync(runtime.paths.globalFile, 'utf8'), before)
    assert.deepEqual(runtime.synced, [])

    const replaced = await dispatch(runtime, 'import', { scope: 'global', text, replace: true })
    assert.equal(replaced.ok, true)
    assert.deepEqual(replaced.value.replaced, ['ida'])
    const read = await readServersFile(runtime.paths.globalFile)
    assert.equal(read.servers.length, 1)
    assert.equal(read.servers[0].command, 'new.exe')
  })
})

test('import：批量 + 部分条目有问题时其余照常导入', async () => {
  await inTemp('partial', async (root, runtime) => {
    const text = json({ mcpServers: { ok: { command: 'a.exe' }, broken: { transport: 'stdio' } } })
    const result = await dispatch(runtime, 'import', { scope: 'global', text })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.imported, ['ok'])
    assert.ok(result.value.warnings.some((line) => line.includes('broken')), result.value.warnings.join('\n'))
    const read = await readServersFile(runtime.paths.globalFile)
    assert.deepEqual(read.servers.map((s) => s.name), ['ok'])
  })
})

test('import：不是 JSON → json-invalid；里面没有服务器 → json-empty', async () => {
  await inTemp('errors', async (root, runtime) => {
    const bad = await dispatch(runtime, 'import', { scope: 'global', text: 'npx -y some-mcp' })
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'json-invalid')

    const empty = await dispatch(runtime, 'import', { scope: 'global', text: json({ hello: { nope: 1 } }) })
    assert.equal(empty.ok, false)
    assert.equal(empty.error.code, 'json-empty')

    const blank = await dispatch(runtime, 'import', { scope: 'global', text: '   ' })
    assert.equal(blank.ok, false)
    assert.equal(blank.error.code, 'json-empty')
    assert.equal(existsSync(runtime.paths.globalFile), false)
  })
})

test('import：文件本身坏了默认拒绝，overwrite 才重建', async () => {
  await inTemp('invalid', async (root, runtime) => {
    writeFileSync(runtime.paths.globalFile, 'servers: [\n  - name: x\n', 'utf8')
    const text = json([{ name: 'ida', command: 'x.exe' }])

    const refused = await dispatch(runtime, 'import', { scope: 'global', text })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'file-invalid')

    const rebuilt = await dispatch(runtime, 'import', { scope: 'global', text, overwrite: true })
    assert.equal(rebuilt.ok, true)
    const read = await readServersFile(runtime.paths.globalFile)
    assert.equal(read.status, 'ok')
    assert.deepEqual(read.servers.map((s) => s.name), ['ida'])
  })
})

test('import：项目作用域写到 <dir>/.dsh/mcp.yml', async () => {
  await inTemp('project', async (root, runtime) => {
    const text = json({ mcpServers: { web: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer T' } } } })
    const result = await dispatch(runtime, 'import', { scope: 'project', text })
    assert.equal(result.ok, true)
    assert.equal(result.value.file, join(runtime.projectDir, '.dsh', 'mcp.yml'))
    const read = await readServersFile(result.value.file)
    assert.equal(read.servers[0].transport, 'streamable-http')
    assert.deepEqual(read.servers[0].headers, { Authorization: 'Bearer T' })
  })
})
