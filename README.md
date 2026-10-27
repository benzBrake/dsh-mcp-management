# dsh-mcp-management

DSH 的 **MCP 管理**：设置页里一个面板管两级 MCP —— 全局（profile 的 `mcp.yml`）和项目（`<项目>/.dsh/mcp.yml`）。不建 preset、不改 `cordis.patch.yml`，面板里加完就热生效。

| 作用域 | 文件 | 谁能用 |
|---|---|---|
| 全局 | `<DSH_HOME>/profiles/<profile>/mcp.yml` | 所有项目、所有会话 |
| 项目 | `<项目>/.dsh/mcp.yml` | 只在该工作目录打开的会话 |

## 快速开始

```powershell
# 装进 profile（link 方式，改源码立即生效）
pwsh -NoProfile -File scripts\install.ps1

# 重启 DSH → 设置 → MCP（浏览器记得 Ctrl+Shift+R）
```

面板用法：顶部 `全局 / 项目` 两个 tab；每台服务器一行，显示工具前缀 `mcp__<name>__*`、传输方式、目标（命令或 URL），带**测试**（真起进程 / 真发一次 `tools/list`，报工具数与延迟）、启停、编辑、删除。

加服务器两条路：**添加 MCP**（逐字段填）和 **粘贴 JSON 导入**（别人给的 `mcpServers` 配置整段贴进来）。

项目 tab 顶部可以选目录：默认取会话的工作目录，也能从已知项目里挑，或者手填绝对路径（选择记在 `localStorage`）。

## 从 JSON 导入

点 **粘贴 JSON 导入**，整段贴进去，输入停 400ms 后宿主就地解析并给出预览（识别格式、台数、每台的目标、同名冲突、被跳过的条目），确认后再点「导入」落盘并立刻重挂。

外层形状全认 —— 因为拿到的是哪种事先不知道：

| 别人给的形状 | 例子 |
|---|---|
| `mcpServers` 映射（Claude Desktop / Cursor / Cline / Continue） | `{"mcpServers":{"ida":{"command":"…","args":["--stdio"]}}}` |
| `servers` 映射或数组（VS Code 系） | `{"servers":{"web":{"type":"http","url":"…"}}}` |
| 服务器数组 | `[{"name":"ida","command":"…"},{"name":"web","url":"…"}]` |
| 数组里塞映射 | `[{"ida":{"command":"…"}}]` |
| 裸名称映射（键就是名字） | `{"ida":{"command":"…"}}` |
| 单台服务器对象 | `{"name":"ida","command":"…"}` |

内层字段也做了兼容：`type` / `transportType` / `transport` 同义词（`stdio` `http` `sse` `remote` …，SSE 按 `streamable-http` 存并给出提示）、`baseUrl` / `serverUrl` / `uri` → `url`、`command` 写成数组（首项是命令、其余进 `args`）、`args` 写成字符串、`env` 写成 `["K=V"]` 数组、`disabled: true` → `enabled: false`、cordis 的 `config:` 包裹。名字里的非法字符（`.`、空格、中文）会被折成 `_` 并提示。

文本层面还顺手容忍：Markdown 代码围栏、BOM、整行 `//` 注释、尾随逗号。整段不是 JSON 会直接报错，单条有问题只跳过那一条，其余照常导入。

同名处理默认是**跳过**并在预览里列出来；勾上 **同名覆盖** 则用 JSON 里的定义替换已有的那台。

## 文件状态与处理

`.dsh/mcp.yml` 有四种状态，面板都对应给出动作：

| 状态 | 表现 | 能做什么 |
|---|---|---|
| `missing` | 提示文件不存在 | 「创建文件」，第一次保存也会自动建父目录 |
| `empty` | 文件在但 0 台服务器 | 直接「添加 MCP」 |
| `ok` | 正常列表 + 挂载了几个会话 | 测试 / 启停 / 编辑 / 删除 |
| `invalid` | 红色报错带 YAML 错因 | 「重新加载」，或「覆盖重建」；**上一份可用挂载不会被掐断** |

## 文件格式

```yaml
servers:
  - name: ida                # 工具前缀 mcp__ida__*
    transport: stdio         # stdio | streamable-http（省略时：有 url 即 http，否则 stdio）
    command: 'D:\tools\ida\idalib-mcp.exe'
    args: ['--stdio']
    cwd: 'D:\work\my-project'
    env: { IDADIR: 'D:\tools\ida' }
    toolCallTimeoutMs: 300000
    enabled: true            # 省略即 true；false = 保留配置不连接

  - name: web
    transport: streamable-http
    url: https://example.test/mcp
    headers: { Authorization: 'Bearer ...' }
```

示例里的路径都是占位，换成自己的。顶层也可以是裸列表（`- name: ...` 直接作为数组元素），读的时候会自动认。旧的 cordis 写法（`- id: ... / name: '@deepseek-ai/dsh-mcp-client' / config: { serverName, ... }`）照样能读，保存时统一成上面的简洁结构。

## 生效时机

| 动作 | 何时生效 |
|---|---|
| 保存 / 删除 / 启停 | 立刻重挂 |
| 新会话 | `agent/created` 时挂，最多等 1.2s，不卡创建 |
| 插件重载 | 给所有现存会话补挂一次 |
| 直接编辑文件 | 文件轮询（900ms）后重挂；写坏了保留上一份可用挂载 |

工具清单是按 step 组装的，所以新挂上的 MCP 在**下一轮**请求里出现，同一轮不会突然多出工具。

**代价**：每个打开的会话各连一份 —— 同一个项目开 N 个会话就是 N 个 MCP 子进程（这是 Agent 作用域隔离换来的）；会话关掉，进程随之退出。

## 旧条目迁移

profile 的 `cordis.patch.yml` 顶层如果还挂着 `name: '@deepseek-ai/dsh-mcp-client'` 的行（含 `insert:` 包裹的），全局 tab 会出现黄色提示，点「迁移到 mcp.yml」把它们搬进 `mcp.yml` 并从补丁里摘掉（补丁先备份成 `.bak-migrate`）。

## 设置里的图标

设置面板左侧导航的图标由宿主 `@deepseek-ai/dsh-client-ui-settings-general` 硬编码：`navIcon(id)` 只给 `account` / `models` / `agent-presets` / `plugins` / `archived-sessions` 画图标，其余 id（包括本面板的 `mcp-management`）一律回退默认齿轮；`settings.section` 的注册选项里没有 icon 字段可传。

所以图标由浏览器半自己补：用的是 **MCP 官方 mark**（modelcontextprotocol.io 的 favicon 图形：三条圆头弧线拼成的 M 形），只留描边、去掉官方图里的黑底方块，颜色走 `currentColor`。

| 环节 | 做法 |
|---|---|
| 认领 | `watchNav()` 盯着 `body`，设置面板渲染后按导航文案（`t("nav")`，即 “MCP”）找到那颗按钮，打 `data-mcp-nav` |
| 画图 | CSS `::before` + `mask-image: url("data:image/svg+xml,…")`，16×16、`background-color: currentColor` |
| 收尾 | `[data-mcp-nav] > svg{display:none}` 把宿主给的齿轮藏掉；面板关掉重开、切语言都会重新认领 |
| 降级 | 拿不到 DOM 时什么都不做，图标退回齿轮，面板功能不受影响 |

要换成自己的图形：改 `src/client/client.js` 里的 `MCP_MARK_SVG`（单色 SVG，任何填充色都会被 mask 替换成 `currentColor`），刷新浏览器即可，不用改宿主。

## 配置

写在 profile 补丁的 loader 行上，全部可省略：

| 字段 | 默认 | 含义 |
|---|---|---|
| `globalFile` | `<profile>/mcp.yml` | 全局清单 |
| `projectFile` | `.dsh/mcp.yml` | 项目清单（相对项目目录） |
| `patchFile` | `<profile>/cordis.patch.yml` | 只有迁移旧条目时才用到 |
| `profileDir` | `$DSH_HOME/profiles/$DSH_PROFILE` | 上面几个默认值的基准目录 |
| `debugFile` | 空 | 填路径则把运行时挂载快照写到那里，排查「为什么没挂上」 |

## 仓库结构

```
src/host/          宿主半：ESM，按职责拆开，无构建步骤
  index.js         插件入口：解析路径 → 建 runtime → 接事件 → 注册 RPC
  constants.js     插件身份 / 版本 / RPC 通道 / 作用域 / 两个 YAML 文件头
  paths.js         globalFile / projectFile / patchFile / debugFile 的解析
  yaml.js          js-yaml 按需加载（含 !!js 标量）+ 从 profile node_modules 兜底
  servers.js       mcp.yml 的读 / 规范化 / 写 / 表单校验
  import.js        别人给的 MCP JSON → server 对象（宽松解析 + 形状兼容）
  entries.js       「服务器 → mcp-client loader 行」+ 内存 EntryTree
  runtime.js       全局挂载、每会话挂载、文件热更新、调试快照
  migrate.js       旧 cordis.patch.yml 顶层 mcp-client 行的识别与摘除
  probe.js         「测试」按钮的真连通探测（stdio / streamable-http）
  rpc.js           /api/mcp-management 的动作实现与分发
src/client/
  client.js        浏览器半：单文件 ModuleLoader 模块（不能拆，没有打包步骤）；含设置导航的 MCP 图标
scripts/
  install.ps1      link 安装 / 卸载（幂等，自动备份 profile；-DryRun 只看不改）
  patch-lines.ps1  profile 补丁里本插件条目的改名 / 补齐 / 摘除
  patch-lines.test.ps1  上面那套行级操作的单测（含真实 profile 只读夹具）
  profile-manifest.ps1  profile 的 dependencies / dsh.profile.bundles 增删
  profile-manifest.test.ps1  上面那套的单测
  check.mjs        包名 / 补丁行 / 模块 id / 版本 / 入口形状的一致性自检
tests/             apply / host / import / client / parity 五组测试 + 行为基线快照
docs/architecture.md      挂载模型、数据流、RPC 协议、命名、已知边界
```

## 开发

```powershell
npm test              # 42 个用例：装配 + 功能 + JSON 导入 + 面板接线 + 导航图标 + 行为基线
npm run check         # 静态自检：包名 / 补丁行 / 模块 id / 版本 / 入口文件 / 行为基线快照
npm run test:patch    # profile 补丁行迁移的单测（PowerShell）
npm run test:manifest # profile 依赖与 bundles 的单测（PowerShell）
```

改代码的注意点：

- **不要给 `src/client/client.js` 加 `import`**：宿主只按 `package.json` 的 `exports["./client"]` 取一个脚本地址，没有打包步骤，它必须保持单文件 + tab 缩进。
- 宿主半是普通 ESM，可以随便拆，但 `__internals` 的键是测试与排错依赖的稳定面，别随手删。
- 依赖（`js-yaml`、`@modelcontextprotocol/sdk`）不在本包的 `node_modules` 里：`yaml.js` 先正常解析，失败后退回 `<profile>/node_modules`。这也是为什么本包**不声明** `dependencies` —— 装了反而会和 profile 里的版本打架。
- 插件有四个必须一致的名字：`package.json` 的 `name`、cordis 的 `name` / `insert.id`（`mcp-management`）、`client.js` 的 `load({ id })`、RPC 前缀 `/api/mcp-management`。改一处就跑 `npm run check`。`mcp__<name>__*` 这个工具前缀来自每个 MCP 自己的 `name`，与插件名无关。

## 安装到 profile

一个插件要在 DSH 里真正跑起来，profile 的**四处**必须同时对上 —— 只改前两处中的一处，就会出现「插件页显示没打开、设置里却还有面板」的状态：

| 位置 | 作用 | 漏了会怎样 |
|---|---|---|
| `package.json` `dependencies` | pnpm 装不装、`node_modules` 里有没有 | 插件页报文件不可读，加载失败 |
| `package.json` `dsh.profile.bundles` | **插件页的开关**；也是应用 bundle patch（本包的 `cordis.patch.yml`）的前提 | 显示「未启用」，补丁不生效 |
| `cordis.patch.yml` 条目 | 插件行的 config（`patchFile` 等） | 用默认路径（一般也对，但 config 丢失） |
| `node_modules/<旧包名>` 符号链接 | 旧 bundle 是否还能被解析 | 旧插件继续加载，和新插件抢同一个面板 |

```powershell
pwsh -NoProfile -File scripts\install.ps1 -DryRun   # 先看它打算改什么（不写文件、不跑 pnpm）
pwsh -NoProfile -File scripts\install.ps1           # 四处一起改，然后 pnpm install
# 重启 DSH（profile 没开 HMR，bundles 变更要重启）+ 浏览器硬刷新
Get-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-mcp-management" | Select-Object Target
```

脚本做的事：依赖里加 `"dsh-mcp-management": "link:<本仓库>"`（并补 `js-yaml` / `@modelcontextprotocol/sdk`）、把包名追加进 `dsh.profile.bundles`、把 `cordis.patch.yml` 里的 `- id: mcp-management` 条目补齐（**块里的自定义 config 原样保留**）、删掉 `node_modules` 里指向旧目录的符号链接（非符号链接只告警）。写之前把 `package.json` / `cordis.patch.yml` 备份成 `*.bak-install-<时间戳>`。

## 排错

1. **面板里有了但会话里没工具**：看「挂载失败」提示；再确认 `name` 没和别的 MCP 撞（同一作用域内唯一）。
2. **`already in use`**：`cordis.patch.yml` 里的旧 mcp-client 行没迁移，和我们挂的实例抢同一个 `serverName`。
3. **想确认真的连上了**：点服务器行上的「测试」，它真起进程、真发 `tools/list`。
4. **改了文件没反应**：点「刷新」；文件监视是 900ms 轮询，网络盘更慢。
5. **想留下证据**：配置 `debugFile`，运行时的挂载快照（含每个会话可见的 `mcp__*` 工具）会写进去。
6. **插件页显示没打开，但设置里还有面板**：`dsh.profile.bundles` 里没这个包、或 `node_modules` 里还有别的同名链接 —— 重跑 `scripts\install.ps1`，然后重启 DSH。
