/**
 * 自底向上的功能测试：不依赖 cordis / DSH 运行时，用 stub runtime 覆盖 RPC 动作。
 *
 * 覆盖点：
 *   - 文件头常量与 entryId 净化
 *   - validateServerInput 的字段级报错
 *   - init / save / toggle / remove 的落盘与错误码
 *   - invalid 文件的两条分支（拒绝写 / 覆盖重建）
 *   - migrate：旧 cordis.patch.yml 顶层 mcp-client 行搬进 mcp.yml
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { GLOBAL_FILE_HEADER, PROJECT_FILE_HEADER, SERVER_NAME_RE } from '../src/host/constants.js'
import { entryIdOf } from '../src/host/entries.js'
import { collectPatchMcpRows, splitHeader } from '../src/host/migrate.js'
import { samePath } from '../src/host/paths.js'
import { dispatch } from '../src/host/rpc.js'
import { readServersFile, validateServerInput } from '../src/host/servers.js'

/** 只实现 rpc 层实际用到的那些方法，挂载动作全部 noop。 */
function stubRuntime(root) {
  const projectDir = join(root, 'proj')
  const agent = { id: 'agent-1', status: 'running', session: { header: { cwd: projectDir } } }
  return {
    paths: {
      profileDir: root,
      globalFile: join(root, 'mcp.yml'),
      projectFile: join('.dsh', 'mcp.yml'),
      patchFile: join(root, 'cordis.patch.yml'),
      debugFile: '',
    },
    runtime: { global: { tree: undefined, mountError: undefined, servers: [] }, agents: new Map(), paths: {} },
    // 一个“正在跑”的会话，这样 guessProjectDir 会落到 projectDir 而不是 process.cwd()
    liveAgents: () => [agent],
    projectDirOf: () => projectDir,
    projectFileOf: (dir) => join(dir, '.dsh', 'mcp.yml'),
    syncGlobal: async () => {},
    syncAgent: async () => {},
    syncAllAgents: () => {},
    dropAgent: () => {},
    dump: () => {},
    watchGlobal: () => {},
    watchProjectFile: () => {},
    close: () => {},
    projectDir,
  }
}

async function inTemp(name, fn) {
  const root = mkdtempSync(join(tmpdir(), `dsh-mcp-management-${name}-`))
  try {
    return await fn(root, stubRuntime(root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('文件头常量：首行说明作用域，字段提示齐全', () => {
  assert.match(GLOBAL_FILE_HEADER, /^# 全局 MCP/)
  assert.match(PROJECT_FILE_HEADER, /^# 项目级 MCP/)
  for (const header of [GLOBAL_FILE_HEADER, PROJECT_FILE_HEADER]) {
    for (const field of ['name', 'transport', 'command/args/cwd', 'url/headers', 'env', 'toolCallTimeoutMs', 'enabled: false']) {
      assert.ok(header.includes(field), `${field} missing in header`)
    }
    assert.equal(header.endsWith('\n'), true)
  }
})

test('entryIdOf: 非法字符折成下划线，保持 loader id 稳定', () => {
  assert.equal(entryIdOf('ida'), 'mcp-ida')
  assert.equal(entryIdOf('a b/c:d'), 'mcp-a_b_c_d')
  assert.equal(entryIdOf('中文'), 'mcp-__')
})

test('samePath: 分隔符与大小写不敏感，undefined 直接 false', () => {
  assert.equal(samePath('D:\\work\\ida-env', 'd:/work/ida-env/'), true)
  assert.equal(samePath('D:\\a', 'D:\\b'), false)
  assert.equal(samePath(undefined, 'D:\\a'), false)
})

test('splitHeader: 只保留第一行条目之前的注释块', () => {
  const text = '# a\n# b\n- id: x\n  name: y\n'
  assert.equal(splitHeader(text), '# a\n# b')
  assert.equal(splitHeader('- id: x\n'), '')
})

test('validateServerInput: 字段级报错', () => {
  assert.deepEqual(validateServerInput({ name: 'ida', transport: 'stdio', command: 'x.exe' }), {})
  assert.deepEqual(validateServerInput({ name: 'ida', transport: 'stdio', command: '  ' }), { command: 'stdio 需要可执行命令' })
  assert.deepEqual(validateServerInput({ name: '带 空格', transport: 'stdio', command: 'x' }), { name: 'name 需要匹配 [A-Za-z0-9_-]{1,32}' })
  assert.deepEqual(validateServerInput({ name: 'web', transport: 'streamable-http', url: 'ftp://x' }), { url: 'streamable-http 需要 http(s):// URL' })
  assert.deepEqual(validateServerInput({ name: 'ida', transport: 'stdio', command: 'x', headers: { A: 1 } }), { headers: 'headers 必须是字符串映射' })
  assert.deepEqual(validateServerInput(null), { _: '请求内容不合法' })
  assert.equal(SERVER_NAME_RE.test('a'.repeat(33)), false)
})

test('init → save → toggle → remove：全局作用域全流程', async () => {
  await inTemp('global-flow', async (root, runtime) => {
    const init = await dispatch(runtime, 'init', { scope: 'global' })
    assert.equal(init.ok, true)
    assert.equal(existsSync(runtime.paths.globalFile), true)
    assert.equal(readFileSync(runtime.paths.globalFile, 'utf8'), GLOBAL_FILE_HEADER + 'servers: []\n')

    const saved = await dispatch(runtime, 'save', {
      scope: 'global',
      server: { name: 'ida', transport: 'stdio', command: '  D:\\tools\\ida\\idalib-mcp.exe ', args: ['--stdio', 1], env: { IDADIR: 'D:\\tools\\ida' }, toolCallTimeoutMs: '300000' },
    })
    assert.equal(saved.ok, true)
    assert.equal(saved.value.saved, 'ida')

    const read = await readServersFile(runtime.paths.globalFile)
    assert.equal(read.status, 'ok')
    assert.deepEqual(read.servers[0], {
      name: 'ida',
      transport: 'stdio',
      command: 'D:\\tools\\ida\\idalib-mcp.exe',
      args: ['--stdio', '1'],
      env: { IDADIR: 'D:\\tools\\ida' },
      toolCallTimeoutMs: 300000,
    })

    const dupe = await dispatch(runtime, 'save', { scope: 'global', server: { name: 'ida', transport: 'stdio', command: 'x.exe' } })
    assert.equal(dupe.ok, false)
    assert.equal(dupe.error.code, 'duplicate-name')

    const bad = await dispatch(runtime, 'save', { scope: 'global', server: { name: 'bad', transport: 'stdio' } })
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'invalid-config')
    assert.deepEqual(bad.error.details.fields, { command: 'stdio 需要可执行命令' })

    const toggled = await dispatch(runtime, 'toggle', { scope: 'global', name: 'ida', enabled: false })
    assert.equal(toggled.ok, true)
    let after = await readServersFile(runtime.paths.globalFile)
    assert.equal(after.servers[0].enabled, false)

    const missing = await dispatch(runtime, 'toggle', { scope: 'global', name: 'ghost', enabled: true })
    assert.equal(missing.error.code, 'not-found')

    const removed = await dispatch(runtime, 'remove', { scope: 'global', name: 'ida' })
    assert.equal(removed.ok, true)
    after = await readServersFile(runtime.paths.globalFile)
    assert.deepEqual(after.servers, [])
    assert.equal(after.status, 'empty')

    const ghost = await dispatch(runtime, 'remove', { scope: 'global', name: 'ida' })
    assert.equal(ghost.error.code, 'not-found')
  })
})

test('项目作用域：写到 <dir>/.dsh/mcp.yml，缺少 dir 时取当前会话目录', async () => {
  await inTemp('project-flow', async (root, runtime) => {
    // 表单里 transport 是必填的：只给 url 不给 transport 会被当成 stdio
    // （2.0.0 的行为，这里保持一致，别“顺手优化”成自动推断）。
    const noTransport = await dispatch(runtime, 'save', {
      scope: 'project',
      server: { name: 'web', url: 'https://example.test/mcp' },
    })
    assert.equal(noTransport.ok, false)
    assert.equal(noTransport.error.code, 'invalid-config')

    const saved = await dispatch(runtime, 'save', {
      scope: 'project',
      server: { name: 'web', transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer T' } },
    })
    assert.equal(saved.ok, true)
    assert.equal(saved.value.file, join(runtime.projectDir, '.dsh', 'mcp.yml'))
    const text = readFileSync(saved.value.file, 'utf8')
    assert.equal(text.startsWith(PROJECT_FILE_HEADER), true)

    const read = await readServersFile(saved.value.file)
    assert.equal(read.servers[0].transport, 'streamable-http')
    assert.deepEqual(read.servers[0].headers, { Authorization: 'Bearer T' })
  })
})

test('invalid 文件：默认拒绝写入，overwrite 才覆盖重建', async () => {
  await inTemp('invalid-flow', async (root, runtime) => {
    writeFileSync(runtime.paths.globalFile, 'servers: [\n  - name: x\n', 'utf8')
    const refused = await dispatch(runtime, 'save', { scope: 'global', server: { name: 'ida', transport: 'stdio', command: 'x.exe' } })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'file-invalid')
    assert.equal(readFileSync(runtime.paths.globalFile, 'utf8'), 'servers: [\n  - name: x\n')

    const overwritten = await dispatch(runtime, 'save', {
      scope: 'global',
      overwrite: true,
      server: { name: 'ida', transport: 'stdio', command: 'x.exe' },
    })
    assert.equal(overwritten.ok, true)
    const read = await readServersFile(runtime.paths.globalFile)
    assert.equal(read.status, 'ok')
    assert.equal(read.servers[0].name, 'ida')
    assert.equal(existsSync(`${runtime.paths.globalFile}.bak`), true)
  })
})

test('state：返回两个作用域、项目清单与路径', async () => {
  await inTemp('state', async (root, runtime) => {
    const value = await dispatch(runtime, 'state', { dir: runtime.projectDir })
    assert.equal(value.ok, true)
    assert.equal(value.value.global.scope, 'global')
    assert.equal(value.value.global.status, 'missing')
    assert.equal(value.value.project.scope, 'project')
    assert.equal(value.value.project.dir, runtime.projectDir)
    assert.deepEqual(value.value.legacy, { count: 0, names: [] })
    assert.equal(value.value.paths.globalFile, runtime.paths.globalFile)
    assert.deepEqual(value.value.projects, [{ dir: runtime.projectDir, sessions: 1, running: 1 }])
  })
})

test('migrate：旧 mcp-client 行搬进 mcp.yml 并从补丁里摘掉', async () => {
  await inTemp('migrate', async (root, runtime) => {
    const patch = [
      '# 手写的补丁',
      '- id: llm-newapi',
      '  name: dsh-llm-newapi',
      '  config:',
      '    baseURL: https://example.test/v1',
      '- insert:',
      '    - id: dsh-purge',
      "      name: dsh-purge",
      '    - name: "@deepseek-ai/dsh-mcp-client"',
      '      config:',
      '        serverName: ida',
      '        transport: stdio',
      '        command: D:\\tools\\ida\\idalib-mcp.exe',
      '        args: ["--stdio"]',
      '',
    ].join('\n')
    writeFileSync(runtime.paths.patchFile, patch, 'utf8')

    const state = await dispatch(runtime, 'state', {})
    assert.equal(state.value.legacy.count, 1)
    assert.deepEqual(state.value.legacy.names, ['ida'])

    const migrated = await dispatch(runtime, 'migrate', {})
    assert.equal(migrated.ok, true)
    assert.deepEqual(migrated.value.names, ['ida'])

    const global = await readServersFile(runtime.paths.globalFile)
    assert.equal(global.servers.length, 1)
    assert.equal(global.servers[0].name, 'ida')
    assert.deepEqual(global.servers[0].args, ['--stdio'])

    const patchText = readFileSync(runtime.paths.patchFile, 'utf8')
    assert.equal(patchText.startsWith('# 手写的补丁'), true)
    assert.equal(patchText.includes('@deepseek-ai/dsh-mcp-client'), false)
    assert.equal(collectPatchMcpRows([{ insert: [] }]).length, 0)
    assert.equal(existsSync(`${runtime.paths.patchFile}.bak-migrate`), true)

    const again = await dispatch(runtime, 'migrate', {})
    assert.deepEqual(again.value, { migrated: 0, names: [] })
  })
})
