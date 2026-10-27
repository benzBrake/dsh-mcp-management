/** 与业务无关的小工具，被 host 侧各模块共用。 */

export function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function isStringRecord(value) {
  return isRecord(value) && Object.values(value).every((v) => typeof v === 'string')
}

export function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** env / headers 一律按字符串映射写回 YAML，避免出现 300000 与 "300000" 两种形态。 */
export function toStringMap(map) {
  const out = {}
  for (const [key, value] of Object.entries(map)) out[key] = String(value)
  return out
}
