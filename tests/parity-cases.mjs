/**
 * 对拍用例：parity 测试与快照生成脚本共用这一份数据。
 *
 * 为什么单独抽出来：快照（tests/fixtures/parity-2.0.0.json）是用 2.0.0 旧实现生成的，
 * 测试则拿新实现跑同样的输入。用例定义只写一次，两边不会漂。
 */

import { homedir } from 'node:os'

/** 快照与仓库里不出现真实用户名：把 home 目录换成 <HOME>，生成与比较两侧各过一次。 */
export function withHomePlaceholder(value) {
  const home = homedir()
  const walk = (node) => {
    if (typeof node === 'string') return home ? node.split(home).join('<HOME>') : node
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, walk(item)]))
    }
    return node
  }
  return walk(value)
}

export const resolvePathsCases = [
  {},
  { patchFile: 'D:\\profiles\\alt\\cordis.patch.yml' },
  { profileDir: 'D:\\profiles\\p1' },
  { profileDir: '  D:\\profiles\\p2  ', globalFile: 'D:\\mcp.yml', projectFile: '.dsh\\mcp.yml', patchFile: 'D:\\p.yml' },
  { globalFile: '  ' },
  { projectFile: 'config\\mcp.yml', debugFile: 'D:\\debug\\mcp.json' },
  { profileDir: 'E:\\p3', debugFile: '   ' },
]

export const normalizeRowCases = [
  { name: 'ida', transport: 'stdio', command: 'D:\\tools\\ida\\idalib-mcp.exe', args: ['--stdio'], cwd: 'D:\\work\\ida-env' },
  { name: 'ida', transport: 'stdio', command: '  D:\\tools\\ida\\idalib-mcp.exe  ', args: [1, 2], env: { IDADIR: 1, X: 'y' }, toolCallTimeoutMs: '300000' },
  { name: 'web', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer T' } },
  { name: 'web', transport: 'streamable-http', url: 'https://example.test/mcp', env: { A: 'b' } },
  { name: 'bad name', command: 'x' },
  { name: 'nocmd', transport: 'stdio' },
  { name: 'nourl', transport: 'streamable-http' },
  { id: 'mcp-ida', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'ida', transport: 'stdio', command: 'x.exe', args: ['--a'] } },
  { id: 'mcp-off', name: '@deepseek-ai/dsh-mcp-client', disabled: true, config: { serverName: 'off', transport: 'stdio', command: 'y.exe' } },
  { name: 'off2', transport: 'stdio', command: 'z.exe', enabled: false },
  { name: 42 },
  'not-an-object',
  null,
]

export const entryRowCases = [
  { name: 'ida', transport: 'stdio', command: 'x.exe', args: ['--stdio'], cwd: 'C:\\w', env: { A: 'b' }, toolCallTimeoutMs: 300000 },
  { name: 'off', transport: 'stdio', command: 'y.exe', enabled: false },
  { name: 'web', transport: 'streamable-http', url: 'https://e.test/mcp', headers: { Authorization: 'Bearer T' } },
]

/** 文件名 → 内容；undefined 表示文件不存在（missing 状态）。 */
export const serversFileSamples = {
  'missing.yml': undefined,
  'empty.yml': '   \n\n',
  'nulls.yml': 'null\n',
  'ok.yml': [
    'servers:',
    '  - name: ida',
    '    transport: stdio',
    '    command: D:\\\\tools\\\\ida\\\\idalib-mcp.exe',
    '    args: ["--stdio"]',
    '    env: { IDADIR: D:\\\\tools\\\\ida }',
    '    toolCallTimeoutMs: 300000',
    '  - name: web',
    '    url: https://example.test/mcp',
    '',
  ].join('\n'),
  'array.yml': ['- name: a', '  command: a.exe', '- name: b', '  url: https://b.test/mcp', ''].join('\n'),
  'dupe.yml': ['servers:', '  - name: same', '    command: a.exe', '  - name: same', '    command: b.exe', ''].join('\n'),
  'badrow.yml': ['servers:', '  - name: "has space"', '    command: a.exe', '  - name: ok', '    command: b.exe', ''].join('\n'),
  'nolist.yml': 'servers: 42\n',
  'scalar.yml': 'just-a-string\n',
  'broken.yml': 'servers: [\n  - name: x\n',
}

export const writeServersCase = {
  header: '# 备注\n# 第二行\n',
  servers: [
    { name: 'ida', transport: 'stdio', command: 'D:\\tools\\ida\\idalib-mcp.exe', args: ['--stdio'], cwd: 'D:\\work\\ida-env', env: { IDADIR: 'D:\\work\\ida-env\\ida91' }, toolCallTimeoutMs: 300000 },
    { name: 'off', transport: 'stdio', command: 'y.exe', enabled: false },
    { name: 'web', transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer T' } },
  ],
  /** 第二次写入只留第一条，用来顺带验证 .bak 的内容。 */
  pruneTo: 1,
}

export function buildPatchRows() {
  return [
    { id: 'llm', name: 'dsh-llm-newapi', config: { baseURL: 'https://x.test' } },
    { insert: [{ id: 'dsh-purge', name: 'dsh-purge' }] },
    { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'ida', command: 'x.exe' } },
    { insert: [{ name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'web', url: 'https://e.test/mcp' } }] },
    { insert: [] },
    { name: '@deepseek-ai/dsh-mcp-client', disabled: true, config: { serverName: 'off', command: 'y.exe' } },
  ]
}

export const dispatchCase = { action: 'nope', data: {} }

/**
 * readServersFile 的结果里 file 是绝对路径、error 可能带临时目录，生成快照与比较时
 * 都要抹掉这些环境差异；值为 undefined 的键也要去掉（JSON 不保存它，否则快照与实跑永远不等）。
 */
export function normalizeReadResult(result, dir) {
  const withoutDir = (text) => (typeof text === 'string' && dir !== undefined ? text.split(dir).join('<DIR>') : text)
  const out = {
    ...result,
    file: String(result.file).replace(/^.*[\\/]/, ''),
    error: withoutDir(result.error),
  }
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key]
  }
  return out
}
