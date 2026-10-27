# 架构说明

面向要改这个插件的人。目标只有一个：**读文件、把 MCP 挂到对的作用域、把面板要的信息交出去**，并且任何一步出错都不能把已经能用的 MCP 掐掉。

## 1. 不变量

1. `readServersFile` 永不抛，四种状态（`missing` / `empty` / `ok` / `invalid`）都能渲染。
2. `invalid` 不动正在跑的挂载，也绝不静默覆盖用户文件（要覆盖必须显式 `overwrite: true`）。
3. `serverName` 在同一作用域内唯一 —— 它是工具前缀 `mcp__<name>__*` 的来源。
4. 项目清单只挂进**该项目的会话**，不挂到 root，不做“切换项目时批量 disabled”那种合成补丁。
5. 本包不声明 `dependencies`：`js-yaml` 与 MCP SDK 从 profile 的 `node_modules` 解析，版本跟随宿主。

## 2. 组件与依赖方向

```
index.js ──► paths.js
   │        runtime.js ──► servers.js ──► yaml.js ──► paths.js
   │            │            │            └────────► util.js
   │            │            └────────► constants.js
   │            ├► entries.js ──► constants.js / util.js
   │            └► probe.js   ──► yaml.js / util.js
   ├► rpc.js  ──► servers.js / import.js / migrate.js / probe.js / runtime(注入) / paths.js
   └► __internals（测试与排错用的稳定出口）
```

依赖是单向的：`rpc.js` 不 import `runtime.js`，运行期对象由 `apply()` 注入。这样 RPC 层可以用 stub runtime 单测（见 `tests/host.test.mjs`）。

## 3. 启动时序

```
apply(ctx, config)
 ├ resolvePaths(config)                 → { profileDir, globalFile, projectFile, patchFile, debugFile }
 ├ createRuntime(ctx, paths, logger)
 ├ ctx.effect(close)                    → 插件卸载时停树、停轮询
 ├ ctx.on('agent/created')              → syncAgent(agent)，最多等 1.2s
 ├ ctx.on('agent/disposed')             → dropAgent(agent.id)
 ├ ctx.inject(['agents'])               → 已有会话补挂一次
 ├ syncGlobal() + watchGlobal()         → 全局清单挂到 root 作用域
 ├ ctx.inject(['connection'])           → 注册 POST /api/mcp-management
 └ debugFile 非空 → 1.5s / 4s 各写一次启动快照
```

## 4. 读路径：文件 → 内存行

```
mcp.yml --readServersFile--> { status, servers[] }      # servers.js
servers[] --toEntryRow--> { id, name: '@deepseek-ai/dsh-mcp-client', config, disabled? }  # entries.js
rows --tree.root.update(rows)--> 运行中的 MCP 实例      # entries.js
```

三种形态别混：

| 形态 | 出现位置 | 关键字段 |
|---|---|---|
| 文件行 | `mcp.yml` 的 `servers[]` | `name` / `transport` / `command` / `url` …（也兼容 cordis 的 `config.serverName`） |
| 内存 server | `servers[]`（规范化后） | 同上，但字段被修剪、类型被统一（`env`/`headers` 一律字符串） |
| loader 行 | EntryTree 里的 entry | `id: mcp-<name>`、`name: '@deepseek-ai/dsh-mcp-client'`、`config.serverName` |

`normalizeServerRow` 认两种写法：看 `row.config` 是对象、名字里带 `/` 或以 `@` 开头，就当 cordis 行处理，真正的字段在 `config` 里；否则按简洁写法读。`disabled: true` 与 `enabled: false` 都映射成内存里的 `enabled: false`。

## 5. 挂载

`entries.js` 不去 import `@deepseek-ai/dsh-agent-preset-registry`，而是沿 `ctx.loader` 的原型链找名为 `EntryTree` 的构造函数（和那个包里的 `PresetTree` 同源做法），然后：

```js
const tree = new EntryTree(baseUrl ? ctx.extend({ baseUrl }) : ctx)
tree.write = () => {}          // 内存树，不落盘
delete tree.ctx.fiber.entry.subtree   // 否则 Loader 会把运行时行当成 profile 配置
delete tree.ctx.fiber.entry.subgroup
```

- **全局**：`createTree(ctx, ctx.baseUrl)` → 落在插件自己的 root 作用域，等价于 profile 补丁顶层 insert 一条 mcp-client 行。
- **项目**：`createTree(agent.ctx, agent.ctx.baseUrl)` → 落进会话自己的 Agent 作用域（`dsh-scope` 的隔离）。A 项目会话看不见 B 项目的 MCP，也不需要合成补丁。
- **冲突重试**：`updateWithRetry` 对 `already in use|already exists|not active|disposed` 这类瞬时错误重试 3 次（400/800ms 退避），因为旧实例可能还没被 Loader 拆完。

## 6. 状态机与容错

```
read.status = missing ─┐
             empty  ───┼─► rows.length === 0 ─► 停树（全局保留 tree 字段但 ready=false 前先停）
             ok     ───┘
             invalid ──► dumpState('*-invalid')，直接 return（保留上一份挂载）
```

挂载失败只写 `mountError` 到 state，面板显示红条，不影响其他作用域。`global.tree` 与每个 agent 的 `state.tree` 都只在 `rows.length > 0` 时创建；行清空时 `stopTree` 并置 `undefined`。

## 7. 热更新

`watchFile(file, label, onChange)` 用 `fs.watchFile({ interval: 900 })`，回调里再做 250ms 去抖。全局清单变更 → `syncGlobal()`；项目清单变更 → 找到该项目所有活着的会话，逐个 `syncAgent`，顺手清理已经消失的会话状态。`close()` 时 `unwatchFile` 全部清空。

## 8. RPC 协议

`POST /api/mcp-management`

```jsonc
// 请求
{ "type": "client-request", "rpcId": "<uuid>", "payload": { "action": "save", "data": { … } } }

// 响应
{ "type": "server-response", "rpcId": "<uuid>",
  "result": { "ok": true, "value": { … } }
         // 或 { "ok": false, "error": { "code": "…", "message": "…", "details": { … } } } }
```

信封不合法（不是 `client-request` 或 `rpcId` 不是字符串）时直接 400 纯文本。

| action | data | 成功 value | 主要错误码 |
|---|---|---|---|
| `state` | `{ dir? }` | `{ global, project, projects[], legacy, paths }` | — |
| `save` | `{ scope, dir?, server, originalName?, overwrite? }` | `{ saved, file, scope }` | `invalid-config`（带 `details.fields`）、`file-invalid`、`duplicate-name` |
| `remove` | `{ scope, dir?, name }` | `{ removed }` | `file-unavailable`、`not-found` |
| `toggle` | `{ scope, dir?, name, enabled }` | `{ name, enabled }` | `file-unavailable`、`not-found` |
| `init` | `{ scope, dir? }` | `{ file }` | — |
| `import` | `{ scope, dir?, text, replace?, overwrite?, dryRun? }` | `{ file, scope, shape, count, imported[], replaced[], skipped[], warnings[], preview[], dryRun, written? }` | `json-invalid`、`json-empty`、`file-invalid` |
| `migrate` | — | `{ migrated, names[], file }` | — |
| `reload` | `{ dir? }` | 同 `state` | — |
| `probe` | `{ server }` | `{ ok, toolCount?, error?, latencyMs }` | — |
| 其他 | — | — | `unknown-endpoint` |
| 内部异常 | — | — | `internal` |

`state` 的形状：

```jsonc
{
  "global":  { "scope": "global", "file", "exists", "status", "servers[]", "warnings[]", "error?", "mountError?", "agents", "mounted", "failed" },
  "project": { "scope": "project", "dir", …同上 },
  "projects": [ { "dir": "D:\\work\\my-project", "sessions": 1, "running": 1 } ],
  "legacy":  { "count": 1, "names": ["ida"] },     // cordis.patch.yml 里遗留的 mcp-client 行
  "paths":   { "globalFile", "projectFile", "patchFile" }
}
```

`dir` 缺省时：项目作用域回退到“第一个 running 会话的工作目录”，没有会话就回退 `process.cwd()`（`guessProjectDir`）。这一点决定了 `npm test` 里必须给 stub 一个 running agent，否则会写到当前目录。

### 8.1 JSON 导入（`import`）

面板的「粘贴 JSON 导入」把整段文本交给宿主，解析只发生在这一侧 —— 预览和真正导入共用 `import.js`，不会出现“预览说 3 台、导入写 2 台”的漂移。

```
text ─► stripJsonWrapper（BOM / 代码围栏 / 整行注释）
     ─► JSON.parse ─失败─► dropTrailingCommas（尊重字符串与转义）─► JSON.parse
     ─► shapeOf（array / mcpServers / servers / mcp / server / map）
     ─► collectEntries（摊平成 [{ row, nameHint? }]）
     ─► buildServer（name 清洗、transport 同义词、url / command / args / env 变体）
     ─► normalizeServerRow（和读 mcp.yml 完全同一条规范化路径）
```

- 整段不是 JSON → `json-invalid`；解析成功但一台都不认识 → `json-empty`（`details.warnings` 带每条被跳过的原因）。
- 同名默认跳过（`skipped[]` 里给出原因），`replace: true` 才覆盖；`overwrite: true` 与 `save` 同义：文件本身解析不了时也照写。
- `dryRun: true` 不落盘、不重挂，只返回 `preview` + 冲突；面板在输入停顿 400ms 后用它做即时预览。
- 单台服务器里 `type: 'sse'` 会按 `streamable-http` 保存并写一条 warning：本插件只支持两种传输，宁可挂得上也不要静默丢掉。

## 9. 兼容性与迁移

- 文件头（`GLOBAL_FILE_HEADER` / `PROJECT_FILE_HEADER`）会原样写到用户磁盘，改字要当成用户可见变更处理。
- 写文件前把旧内容备份成 `<file>.bak`；迁移补丁前备份成 `<file>.bak-migrate`。
- `migrate` 把旧行规范化后合并进 `mcp.yml`（重名跳过），再从补丁里摘掉这些行；摘除按容器分组、从后往前删，空的 `insert:` 数组一并清掉；然后等 900ms 再 `syncGlobal()`，避开 `serverName` 冲突。
- `yaml.js` 里的 `!!js` 标量类型是给旧补丁用的：解析成 `{ __jsExpr }` 而不是报错，写回时还能还原。

### 9.1 命名：四处必须一致

一个插件有四个名字，改一处就必须一起改其余三处（`scripts/check.mjs` 会拦）：

| 位置 | 值 | 谁在用 |
|---|---|---|
| `package.json` `name` | `dsh-mcp-management` | pnpm `link:` 的链接名、`node_modules` 目录名 |
| cordis 插件 `name` / `insert.id` | `mcp-management` | Loader 条目 id；profile 里 `- id: mcp-management` 的 config 覆盖按它匹配 |
| `client.js` `load({ id })` | `dsh-mcp-management` | 浏览器 ModuleLoader 的模块 id |
| RPC 前缀 | `mcp-management`（→ `/api/mcp-management`） | 面板 → 宿主 |

本插件早先叫 `dsh-mcp-presets` / `mcp-presets`，老 profile 里可能还留着这些名字。**profile 需要迁移**，由 `scripts/install.ps1` 完成（行级实现见 `scripts/patch-lines.ps1`）：

1. 依赖表里删掉 `dsh-mcp-presets`，加 `dsh-mcp-management: link:<repo>`；`node_modules` 里的旧链接随之一并清掉。
2. 补丁文本里 `name: 'dsh-mcp-presets'` → `name: 'dsh-mcp-management'`、`- id: mcp-presets` → `- id: mcp-management`、注释行改名；**块内自定义 config 原样保留**（例如 `debugFile`）。
3. 只有当补丁里既没有 `- id: mcp-management` 也没有 `name: 'dsh-mcp-management'` 时才补一段 `insert` + `config.patchFile`：已有条目说明包自带的 `cordis.patch.yml` bundle 层负责 insert，profile 只做 config 覆盖，再插一条没有意义。

`mcp.yml` 本体不需要迁移：文件名、字段、工具前缀 `mcp__<name>__*` 都和插件名无关，只有文件头注释里的插件名会在下次保存时刷新。浏览器侧的 `localStorage` 键改了名，`readStoredDir()` 会先读旧键并把值搬到新键。

## 10. 已知边界

1. **每会话一份进程**：作用域隔离的代价。要有“项目内共享一份”的能力，得改宿主侧的作用域模型，不是这个插件能解决的。
2. **工具清单按 step 组装**：新挂的 MCP 在下一轮请求才出现。
3. **浏览器半不能拆文件**：`exports["./client"]` 只给一个脚本地址，没有打包步骤。
4. **表单的 `transport` 是显式字段**：只填 URL 不选 transport 会被当成 stdio 并报 `command` 必填（既有行为，测试里锁住了）。JSON 导入不受这条限制：它会按 `url` / `command` / `type` 自己推断。
5. **`servers:` 顶层列表**可用，但写回时统一成 `servers:` 对象形式。
6. **SSE 只能近似**：`type: 'sse'` 的端点按 `streamable-http` 存，能不能连通要用行上的「测试」验一下 —— 传输模型只有 stdio / streamable-http 两种，这是插件的地基，不为导入临时扩。
7. **设置导航的图标没有扩展点**：宿主的 `navIcon(id)` 是硬编码 id → 图标的映射，`settings.section` 的注册选项里也没有 icon 字段。本插件只能在后半自己认领按钮（`data-mcp-nav`）+ CSS 伪元素画 MCP mark；宿主若改了导航的 DOM 形状或按钮文案，认领会退化成齿轮，功能不受影响。

## 11. 测试策略

- `tests/parity.test.mjs`：行为基线测试。基线是 `tests/fixtures/parity-2.0.0.json`（16 KB），由 `scripts/snapshot-parity.mjs` 跑旧单文件实现生成，覆盖纯函数、四种文件状态、落盘字节与 `.bak`、patch 行收集/删除、未知 action 的 envelope。生成后不再依赖旧实现源码；快照里记的是旧插件名（`mcp-presets`），改名是唯一被显式放行的差异，测试断言当前名。用例定义在 `tests/parity-cases.mjs`，测试与生成脚本共用。
- `tests/host.test.mjs`：用 stub runtime 覆盖 RPC 全流程（init → save → toggle → remove、项目作用域、invalid 的两条分支、state 形状、migrate）。
- `tests/import.test.mjs`：JSON 导入的形状矩阵（mcpServers / 数组 / 数组套映射 / 裸映射 / 单台 / cordis 行）、内层字段变体、宽松文本、整段报错与单条跳过，以及 `dryRun` / 同名跳过与覆盖 / 坏文件 overwrite 的落盘行为。
- `tests/client.test.mjs`：浏览器半的接线测试。给一份极简 hooks 实现（`useState` / `useEffect` / `useCallback`），把 `client.js` 真 import 进来并像用户那样点「粘贴 JSON 导入」、输入、点「导入」，断言发出去的 RPC 动作与参数（`state` → `import{dryRun}` → `import`）以及渲染出来的文案。另外两个用例锁设置导航图标的认领规则（只认文案匹配的那颗按钮、面板没开时什么都不做）。不测样式，只测约定。
- `tests/apply.test.mjs`：假 ctx 真跑 `apply()`，验 RPC 注册路径 / 信封校验 / 没有 loader 时的降级（`mountError` + warn 而不是抛）。
- `scripts/patch-lines.test.ps1`（`npm run test:patch`）：补丁行改名 / 补齐 / 摘除的单测，用真实 profile 的 `cordis.patch.yml` 当只读夹具，并通过 js-yaml 校验改完仍能解析、其它插件条目未被破坏。
- `scripts/profile-manifest.test.ps1`（`npm run test:manifest`）：profile 的 `dependencies` 与 `dsh.profile.bundles` 增删逻辑，覆盖“只改依赖不改 bundles → 插件页显示没打开”这个坑。
- `scripts/check.mjs`：包名 / 补丁 insert 行 / ModuleLoader id / `PLUGIN_VERSION` 与 `package.json` 一致 / 入口文件 / `__internals` 键 / 行为基线快照存在且来源正确。

`js-yaml` 从 profile 兜底解析，所以测试不需要在仓库里 `npm install`；换机器时确保 `$DSH_HOME/profiles/desktop/node_modules/js-yaml` 存在，或用 `DSH_HOME` / `DSH_PROFILE` 指过去。
