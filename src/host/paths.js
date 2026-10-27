/**
 * 路径解析：插件读写的三个文件位置全部由 profile 决定，可用配置覆盖。
 *
 *   全局清单   <profile>/mcp.yml                 （config.globalFile）
 *   项目清单   <项目>/.dsh/mcp.yml               （config.projectFile，相对项目目录）
 *   profile 补丁 <profile>/cordis.patch.yml      （config.patchFile，仅迁移旧条目时用）
 *   调试快照   config.debugFile（可选）
 */

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function homeDir() {
  return process.env['DSH_HOME']?.trim() || join(homedir(), '.dsh')
}

export function profileName() {
  return process.env['DSH_PROFILE']?.trim() || 'desktop'
}

export function defaultProfileDir() {
  return join(homeDir(), 'profiles', profileName())
}

/**
 * 把 loader 行上的 config 归一成一组绝对路径。
 * profileDir 显式给出时优先；其次从 patchFile 反推（老配置只写了 patchFile）；
 * 都没有就退回 DSH_HOME/DSH_PROFILE。
 */
export function resolvePaths(config) {
  const profileDir =
    typeof config?.profileDir === 'string' && config.profileDir.trim() !== ''
      ? config.profileDir.trim()
      : typeof config?.patchFile === 'string' && config.patchFile.trim() !== ''
        ? dirname(config.patchFile.trim())
        : defaultProfileDir()
  const globalFile =
    typeof config?.globalFile === 'string' && config.globalFile.trim() !== ''
      ? config.globalFile.trim()
      : join(profileDir, 'mcp.yml')
  const projectFile =
    typeof config?.projectFile === 'string' && config.projectFile.trim() !== ''
      ? config.projectFile.trim()
      : join('.dsh', 'mcp.yml')
  const patchFile =
    typeof config?.patchFile === 'string' && config.patchFile.trim() !== ''
      ? config.patchFile.trim()
      : join(profileDir, 'cordis.patch.yml')
  const debugFile =
    typeof config?.debugFile === 'string' && config.debugFile.trim() !== '' ? config.debugFile.trim() : ''
  return { profileDir, globalFile, projectFile, patchFile, debugFile }
}

/** Windows 路径大小写不敏感，比较前统一一下。 */
export function samePath(left, right) {
  if (left === undefined || right === undefined) return false
  const normalize = (value) => String(value).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalize(left) === normalize(right)
}
