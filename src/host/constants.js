/**
 * 常量：插件身份、RPC 通道、作用域、清单文件头。
 *
 * 这里的字符串会直接落进用户磁盘（两个 YAML 头）或变成 Loader 行的 name，
 * 改动前先看 docs/architecture.md 的“兼容性”一节。
 */

/** 被挂载的宿主机插件：配置一行，就是一个 MCP 服务器实例。 */
export const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

/** 插件名：cordis 里插件的 name（cordis.patch.yml 里 insert 的 id 必须一致）。 */
export const PLUGIN_NAME = 'mcp-management'

/** 与 package.json 的 version 保持同步（scripts/check.mjs 会校验）。 */
export const PLUGIN_VERSION = '1.0.0'

/** 浏览器侧 RPC 前缀，与 client.js 里的 PREFIX 必须一致。 */
export const PREFIX = 'mcp-management'

/** RPC 挂在宿主的 /api 前缀下。 */
export const CHANNEL = '/api'

/** 完整 RPC 路径：POST /api/mcp-management */
export const RPC_PATH = `${CHANNEL}/${PREFIX}`

/** serverName 同时是工具前缀（mcp__<name>__*）和 entry id 的来源，字符集收窄。 */
export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

export const GLOBAL_SCOPE = 'global'
export const PROJECT_SCOPE = 'project'

export const PROJECT_FILE_HEADER = `# 项目级 MCP —— 只在这个工作目录的会话里生效（dsh-mcp-management 管理）
#
# name              → 工具前缀 mcp__<name>__*
# transport         → stdio | streamable-http
# command/args/cwd  → stdio 启动命令
# url/headers       → streamable-http 地址
# env               → 子进程环境变量
# toolCallTimeoutMs → 单次工具调用超时
# enabled: false    → 保留配置但不连接
`

export const GLOBAL_FILE_HEADER = `# 全局 MCP —— 所有项目、所有会话都能用（dsh-mcp-management 管理）
#
# name              → 工具前缀 mcp__<name>__*
# transport         → stdio | streamable-http
# command/args/cwd  → stdio 启动命令
# url/headers       → streamable-http 地址
# env               → 子进程环境变量
# toolCallTimeoutMs → 单次工具调用超时
# enabled: false    → 保留配置但不连接
`
