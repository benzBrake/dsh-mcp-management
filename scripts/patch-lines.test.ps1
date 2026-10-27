# patch-lines.ps1 的单测（不需要 Pester）
#   pwsh -NoProfile -File scripts\patch-lines.test.ps1
#
# 用真实 profile 的 cordis.patch.yml 当夹具（只读），外加合成用例：
#   - 旧 insert 块改名 → 保留 config、不留旧名
#   - 顶层 - id: mcp-presets 覆盖块改名 → config 保留
#   - 缺条目时补块 → YAML 能解析、patchFile 正确
#   - 卸载 → 两个名字的块都不留，其它插件条目逐字不动

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'patch-lines.ps1')

$script:failed = 0
function Check([string]$Name, [bool]$Condition, [string]$Detail = '') {
  if ($Condition) {
    "ok   $Name"
  } else {
    "FAIL $Name$(if ($Detail) { " —— $Detail" })"
    $script:failed++
  }
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("patch-lines-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$jsYaml = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\js-yaml\index.js'
function Test-Yaml([string]$Path) {
  if (-not (Test-Path $jsYaml)) { return 'skip' }
  $probe = "const y=require(process.argv[1]);const fs=require('fs');try{y.load(fs.readFileSync(process.argv[2],'utf8'));console.log('ok')}catch(e){console.log('bad:'+e.message)}"
  $out = & node -e $probe $jsYaml $Path 2>&1
  return ($out | Select-Object -Last 1)
}

try {
  # ── 合成用例：旧 insert 块（带注释与 config）────────────────────────────────
  $legacy = @(
    '# 手写的补丁'
    '- id: llm-newapi'
    '  name: dsh-llm-newapi'
    '  config:'
    '    baseURL: https://example.test/v1'
    '- id: mcp-presets'
    '  config:'
    '    patchFile: C:\Users\demo\.dsh\profiles\desktop\cordis.patch.yml'
    '- insert:'
    '    - id: dsh-purge'
    "      name: dsh-purge"
    ''
  ) -join "`n"
  $migrated = Move-PluginPatchToCurrentName $legacy
  Check '旧 id 覆盖块改名' ($migrated -match '(?m)^- id: mcp-management$')
  Check '旧名不再出现' (-not ($migrated -match 'mcp-presets'))
  Check '覆盖块里的 config 保留' ($migrated -match '(?m)^\s+patchFile: C:\\Users')
  Check '其它条目不动' (($migrated.Contains('name: dsh-llm-newapi')) -and ($migrated.Contains('name: dsh-purge')))

  # ── 合成用例：旧 insert 块改名 ─────────────────────────────────────────────
  $legacyInsert = @(
    '# dsh-mcp-presets：项目级 MCP + 可视化管理（设置 → MCP 预设）'
    '- insert:'
    '    - id: mcp-presets'
    "      name: 'dsh-mcp-presets'"
    '      config:'
    '        patchFile: C:\x\cordis.patch.yml'
    '        debugFile: C:\x\mcp-debug.json'
    ''
  ) -join "`n"
  $migratedInsert = Move-PluginPatchToCurrentName $legacyInsert
  Check 'insert 块改名' ($migratedInsert -match "(?m)^\s+name: 'dsh-mcp-management'$")
  Check 'insert 里的自定义 debugFile 保留' ($migratedInsert -match 'debugFile: C:\\x\\mcp-debug\.json')
  Check '改名后仍被判定为存在' (Test-PluginPatchPresent $migratedInsert)

  # ── 合成用例：缺条目时补块 ─────────────────────────────────────────────────
  $plain = "# 只有别人`n- id: ui-chat`n  name: '@deepseek-ai/dsh-client-ui-chat'`n"
  Check '无本插件时 present=false' (-not (Test-PluginPatchPresent $plain))
  Check '无本插件时 entry=false' (-not (Test-PluginEntryPresent $plain))
  $added = Add-PluginPatchBlock $plain -PatchFile 'C:\Users\demo\.dsh\profiles\desktop\cordis.patch.yml'
  Check '补块后 present=true' (Test-PluginPatchPresent $added)
  Check '补块后 entry=true' (Test-PluginEntryPresent $added)
  Check '补块带 patchFile' ($added -match 'patchFile: ''C:\\Users')
  $addedPath = Join-Path $tmp 'added.yml'
  [IO.File]::WriteAllText($addedPath, $added, (New-Object System.Text.UTF8Encoding($false)))
  $yamlState = Test-Yaml $addedPath
  Check '补块后 YAML 可解析' ($yamlState -eq 'ok' -or $yamlState -eq 'skip') "yaml=$yamlState"

  # ── 卸载：两个名字的块都摘掉 ───────────────────────────────────────────────
  $removed = Remove-PluginPatchBlock $added
  Check '卸载后没有 mcp-management 块' (-not ($removed -match 'mcp-management'))
  Check '卸载后保留 ui-chat' ($removed -match 'ui-chat')
  $removedPath = Join-Path $tmp 'removed.yml'
  [IO.File]::WriteAllText($removedPath, $removed, (New-Object System.Text.UTF8Encoding($false)))
  $removedYaml = Test-Yaml $removedPath
  Check '卸载后 YAML 可解析' ($removedYaml -eq 'ok' -or $removedYaml -eq 'skip') "yaml=$removedYaml"

  # ── 真实 profile 夹具（只读）──────────────────────────────────────────────
  $livePatch = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml'
  if (Test-Path $livePatch) {
    $live = [IO.File]::ReadAllText($livePatch)
    $liveMigrated = Move-PluginPatchToCurrentName $live
    $appended = $false
    if (-not (Test-PluginEntryPresent $liveMigrated)) {
      $liveMigrated = Add-PluginPatchBlock $liveMigrated -PatchFile $livePatch
      $appended = $true
    }
    if (-not ($live -match "name: 'dsh-mcp-(presets|management)'")) {
      Check '真实补丁：已有 id 条目时不再补 insert 块' (-not $appended)
    }
    $livePath = Join-Path $tmp 'live-migrated.yml'
    [IO.File]::WriteAllText($livePath, $liveMigrated, (New-Object System.Text.UTF8Encoding($false)))
    Check '真实补丁：旧名清零' (-not ($liveMigrated -match 'mcp-presets'))
    Check '真实补丁：只剩一个 mcp-management 条目' ((([regex]::Matches($liveMigrated, '(?m)^\s*- id: mcp-management\s*$')).Count) -eq 1)
    foreach ($keep in @('llm-newapi', 'agent-default-model', 'ui-settings-account', 'ui-chat', 'dsh-purge')) {
      Check "真实补丁：$keep 未被破坏" ($liveMigrated -match [regex]::Escape($keep))
    }
    Check '真实补丁：迁移后 YAML 可解析' ((Test-Yaml $livePath) -in @('ok', 'skip'))
    $liveRemoved = Remove-PluginPatchBlock $liveMigrated
    $liveRemovedPath = Join-Path $tmp 'live-removed.yml'
    [IO.File]::WriteAllText($liveRemovedPath, $liveRemoved, (New-Object System.Text.UTF8Encoding($false)))
    Check '真实补丁：卸载后不再引用本插件' (-not ($liveRemoved -match 'mcp-management|mcp-presets'))
    Check '真实补丁：卸载后 YAML 可解析' ((Test-Yaml $liveRemovedPath) -in @('ok', 'skip'))
  } else {
    'skip 真实 profile 夹具（找不到 cordis.patch.yml）'
  }
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:failed -gt 0) { throw "$script:failed 个用例失败" }
'patch-lines: 全部通过'
