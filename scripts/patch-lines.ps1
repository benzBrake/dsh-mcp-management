# profile 的 cordis.patch.yml 里“本插件那一块”的读写。
#
# 只做行级/定点替换：别的插件条目一个字符都不碰。
# 三个名字的来历：
#   dsh-mcp-presets    旧包名（早期版本 load 时 insert 行也用这个名字）
#   dsh-mcp-management 现在的包名 / 模块 id / insert name
#   mcp-management     cordis 条目 id（insert 的 id 与顶层 config 覆盖都用它）
#
# 被 scripts/install.ps1 dot-source；单测在 scripts/patch-lines.test.ps1。
# 三个名字在本文件里直接以字面量出现在正则中，避免“常量与实际匹配漂移”。

function Get-PatchEol([string]$Text) {
  if ($Text -match "`r`n") { return "`r`n" }
  return "`n"
}

# 旧名 → 新名，原地改名（保留块里用户自己加的 config，比如 debugFile）
function Move-PluginPatchToCurrentName {
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
  $out = $Text -replace "(?m)^(\s*)name: 'dsh-mcp-presets'(\s*?)$", "`${1}name: 'dsh-mcp-management'`${2}"
  $out = $out -replace '(?m)^(\s*)- id: mcp-presets(\s*?)$', '${1}- id: mcp-management${2}'
  $out = $out -replace '(?m)^# dsh-mcp-presets(.*?)$', '# dsh-mcp-management${1}'
  return $out
}

function Test-PluginPatchPresent {
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
  return [bool]($Text -match "(?m)^\s*name: 'dsh-mcp-management'\s*$")
}

# 条目是否已在补丁里出现：既可能是 `- id: mcp-management` 的 config 覆盖行，
# 也可能是 insert 里的 `- id: mcp-management` 子行。包自带的 cordis.patch.yml
# 已经负责 insert，所以这两种情况都不需要再补块。
function Test-PluginEntryPresent {
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
  return [bool]($Text -match '(?m)^\s*- id: mcp-management\s*$')
}

# 没有本插件条目时补一段（带 config.patchFile：迁移旧条目、定位补丁文件都要它）
function Add-PluginPatchBlock {
  param(
    [Parameter(Mandatory)][AllowEmptyString()][string]$Text,
    [Parameter(Mandatory)][string]$PatchFile
  )
  $eol = Get-PatchEol $Text
  $block = @(
    '# dsh-mcp-management：全局 / 项目级 MCP 可视化管理（设置 → MCP）'
    '- insert:'
    '    - id: mcp-management'
    "      name: 'dsh-mcp-management'"
    '      config:'
    "        patchFile: '$PatchFile'"
  ) -join $eol
  $body = $Text.TrimEnd()
  if ($body -eq '') { return $block + $eol }
  return $body + $eol + $block + $eol
}

# 卸载：把 insert 块和本插件的顶层 config 覆盖块一起摘掉（两个名字都认）
function Remove-PluginPatchBlock {
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
  $eol = Get-PatchEol $Text
  $lines = [System.Collections.Generic.List[string]]::new()
  foreach ($line in ($Text -split "`r?`n")) { $lines.Add($line) }
  $drop = [System.Collections.Generic.HashSet[int]]::new()

  # 1) 含 name: '<本插件>' 的行 → 向上找到所属 insert 块起点，向下吃到下一个顶层条目
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -notmatch "^\s*name: '(dsh-mcp-presets|dsh-mcp-management)'\s*$") { continue }
    $start = $i
    for ($j = $i; $j -ge 0; $j--) {
      if ($lines[$j] -match '^- insert:\s*$') { $start = $j; break }
      if ($j -ne $i -and $lines[$j] -match '^- ') { break }
    }
    while ($start -gt 0 -and $lines[$start - 1] -match '^#.*dsh-mcp-(presets|management)') { $start-- }
    $end = $i + 1
    while ($end -lt $lines.Count -and $lines[$end] -notmatch '^- ') { $end++ }
    for ($k = $start; $k -lt $end; $k++) { [void]$drop.Add($k) }
  }

  # 2) 顶层 `- id: <本插件>` 的 config 覆盖块
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -notmatch '^- id:\s*(mcp-presets|mcp-management)\s*$') { continue }
    $end = $i + 1
    while ($end -lt $lines.Count -and $lines[$end] -notmatch '^- ') { $end++ }
    for ($k = $i; $k -lt $end; $k++) { [void]$drop.Add($k) }
  }

  $out = [System.Collections.Generic.List[string]]::new()
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if (-not $drop.Contains($i)) { $out.Add($lines[$i]) }
  }
  $result = ($out -join $eol)
  $result = [regex]::Replace($result, '(\r?\n){3,}', $eol + $eol)
  return $result.TrimEnd() + $eol
}
