# CHANGELOG

## 1.0.0 — MCP 管理面板

DSH 设置页里的 MCP 管理器：全局与项目两级清单，面板里加完即热生效，不用手写 `cordis.patch.yml`。

**功能**

- 两个作用域：全局（`<profile>/mcp.yml`，所有项目所有会话）与项目（`<项目>/.dsh/mcp.yml`，只在该工作目录的会话）。
- 项目清单挂进会话自己的 Agent 作用域，靠 `dsh-scope` 隔离；全局挂插件自己的 root 作用域。
- 面板：每台服务器一行，显示工具前缀 `mcp__<name>__*`、传输方式、目标，带启停 / 编辑 / 删除 / 测试
  （测试真起进程或发一次 `tools/list`，报工具数与延迟）。
- 加服务器两条路：逐字段填写，或**粘贴 JSON 导入** —— 认 `mcpServers` / `servers` / 数组 / 裸映射 / 单台对象，
  兼容 `type` 同义词、`baseUrl`、`command` 数组、`env: ["K=V"]`、代码围栏 / BOM / 尾随逗号；
  导入前 400ms 停顿自动预览（识别格式、台数、同名冲突、被跳过的条目），同名默认跳过、可勾选覆盖。
- 文件四态（`missing` / `empty` / `ok` / `invalid`）都有对应动作；`invalid` 不掐断上一份可用挂载，
  写盘前把旧文件备份成 `.bak`。
- 生效时机：保存 / 删除 / 启停立即重挂；新会话在 `agent/created` 挂（最多等 1.2s）；直接改文件走 900ms 轮询；
  插件重载给现存会话补挂一次。
- 旧 `cordis.patch.yml` 顶层的 `dsh-mcp-client` 行可一键迁移进 `mcp.yml`（补丁先备份 `.bak-migrate`）。
- 设置导航里给本面板画 MCP 官方 mark：宿主的 `navIcon(id)` 只认固定几个 id，导航图标由浏览器半自行认领按钮
  + CSS 伪元素补上，拿不到 DOM 时安静退回默认齿轮。
- `scripts/install.ps1`：link 安装 / 卸载，同时维护 `dependencies`、`dsh.profile.bundles`、`cordis.patch.yml` 与
  `node_modules` 里的旧链接，幂等、带备份、`-DryRun` 只看不改。

**文件格式**

```yaml
servers:
  - name: ida
    transport: stdio         # stdio | streamable-http（省略时：有 url 即 http，否则 stdio）
    command: '...\idalib-mcp.exe'
    args: ['--stdio']
    enabled: true
```

顶层裸列表、cordis 的 `- id: / name: / config:` 写法都能读，保存时统一成上面的简洁结构。

**自检**

- `npm test`：装配、功能、JSON 导入、面板接线、导航图标认领、行为基线（42 个用例）。
- `npm run check`：包名 / 补丁行 / 模块 id / `PLUGIN_VERSION` / 入口文件 / `__internals` 键 / 行为基线快照。
- `npm run test:patch`、`npm run test:manifest`：profile 补丁行与依赖 / bundles 的 PowerShell 单测。
