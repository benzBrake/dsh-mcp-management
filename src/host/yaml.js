/**
 * YAML 依赖的按需加载。
 *
 * js-yaml 不在本包的 node_modules 里（插件是 pnpm link 进 profile 的），
 * 所以先按正常解析，失败再退回 <profile>/node_modules 的实体路径。
 * 顺带定义了 `!!js` 标量类型：profile 补丁里的旧条目可能带表达式，
 * 解析时保留成 { __jsExpr } 而不是直接炸掉。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { defaultProfileDir } from './paths.js'

export async function importFromProfile(specifier, fallbackRelPath) {
  try {
    return await import(specifier)
  } catch (error) {
    if (fallbackRelPath === undefined || fallbackRelPath === null) throw error
    const fallback = join(defaultProfileDir(), 'node_modules', fallbackRelPath)
    if (!existsSync(fallback)) throw error
    return await import(pathToFileURL(fallback).href)
  }
}

let yamlPromise

export async function loadYaml() {
  yamlPromise ??= (async () => {
    const mod = await importFromProfile('js-yaml', 'js-yaml/index.js')
    return mod.default
  })()
  return yamlPromise
}

export async function yamlSchema() {
  const yaml = await loadYaml()
  const JsExprType = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (d) => typeof d === 'string',
    construct: (d) => ({ __jsExpr: d }),
    predicate: (v) => v instanceof Object && '__jsExpr' in v,
    represent: (d) => d['__jsExpr'],
  })
  return { yaml, schema: yaml.JSON_SCHEMA.extend(JsExprType) }
}
