# profile-manifest.ps1 的单测（不需要 Pester）
#   pwsh -NoProfile -File scripts\profile-manifest.test.ps1
#
# 重点：bundles 是插件页开关的唯一真相，改名时必须从 bundles 里换掉旧名，
# 只改 dependencies 会得到“装了但没启用”的状态。

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'profile-manifest.ps1')

$script:failed = 0
function Check([string]$Name, [bool]$Condition, [string]$Detail = '') {
  if ($Condition) {
    "ok   $Name"
  } else {
    "FAIL $Name$(if ($Detail) { " —— $Detail" })"
    $script:failed++
  }
}

$repo = Split-Path -Parent $PSScriptRoot

# ── 依赖 ────────────────────────────────────────────────────────────────────
$deps = @{
  'dsh-llm-newapi'   = '0.2.0-rc.2-v0.1'
  'dsh-mcp-presets'  = 'link:D:/work/ida-env/plugins/dsh-mcp-presets'
  'dsh-purge'        = 'https://example.test/dsh-purge.tar.gz'
}
$installed = Resolve-ProfileDependencies -Existing $deps -PluginPath $repo
Check '依赖：旧名被删' (-not $installed.Contains($script:LegacyPackageName))
Check '依赖：新名指向本仓库' ($installed[$script:PackageName] -eq "link:$($repo -replace '\\','/')")
Check '依赖：其它包原样保留' (($installed['dsh-llm-newapi'] -eq '0.2.0-rc.2-v0.1') -and ($installed.Contains('dsh-purge')))
Check '依赖：补上 js-yaml 与 MCP SDK' (($installed.Contains('js-yaml')) -and ($installed.Contains('@modelcontextprotocol/sdk')))

$uninstalled = Resolve-ProfileDependencies -Existing $installed -PluginPath $repo -Uninstall
Check '卸载：两个名字都不在依赖里' ((-not $uninstalled.Contains($script:LegacyPackageName)) -and (-not $uninstalled.Contains($script:PackageName)))
Check '卸载：其它依赖保留' ($uninstalled.Contains('dsh-llm-newapi'))

# ── bundles ─────────────────────────────────────────────────────────────────
$bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-llm-newapi', 'dsh-purge', 'dsh-mcp-presets')
$enabled = Resolve-ProfileBundles -Existing $bundles
Check 'bundles：旧名被换掉' (-not ($enabled -contains $script:LegacyPackageName))
Check 'bundles：新名在列表里' ($enabled -contains $script:PackageName)
Check 'bundles：新名追加在末尾（优先级最低）' ($enabled[-1] -eq $script:PackageName)
Check 'bundles：其它组合包顺序不变' (($enabled[0..3] -join ',') -eq '@deepseek-ai/dsh-base,@deepseek-ai/dsh-web-app,dsh-llm-newapi,dsh-purge')

$again = Resolve-ProfileBundles -Existing $enabled
Check 'bundles：重复执行不产生重复项' (($again -join '|') -eq ($enabled -join '|'))

$cleared = Resolve-ProfileBundles -Existing $enabled -Uninstall
Check '卸载：bundles 里没有本插件' (-not ($cleared -contains $script:PackageName))
Check '卸载：其它组合包保留' ($cleared -contains 'dsh-purge')

$empty = Resolve-ProfileBundles -Existing @()
Check '空 profile：安装后只有本插件' (($empty.Count -eq 1) -and ($empty[0] -eq $script:PackageName))

# ── manifest 往返（真实 profile 结构）────────────────────────────────────────
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("profile-manifest-test-" + [guid]::NewGuid().ToString('N') + '.json')
try {
  @'
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": { "dsh-purge": "https://example.test/p.tar.gz", "dsh-mcp-presets": "link:D:/old" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-purge", "dsh-mcp-presets"] } }
}
'@ | Set-Content -Path $tmp -Encoding utf8 -NoNewline

  $read = Read-ProfileManifest -Path $tmp
  $newDeps = Resolve-ProfileDependencies -Existing $read.Dependencies -PluginPath $repo
  $newBundles = Resolve-ProfileBundles -Existing $read.Bundles
  $written = Write-ProfileManifestShape -Manifest $read.Manifest -Dependencies $newDeps -Bundles $newBundles
  $json = $written | ConvertTo-Json -Depth 12
  $round = $json | ConvertFrom-Json

  Check 'manifest：dependencies 重建后仍是对象' ($round.dependencies.PSObject.Properties.Name -contains $script:PackageName)
  Check 'manifest：bundles 重建后是数组且末尾是本插件' (($round.dsh.profile.bundles[-1]) -eq $script:PackageName)
  Check 'manifest：没有残留旧名' (-not ($json -match 'mcp-presets'))
  Check 'manifest：其它字段保留' (($round.name -eq 'dsh-profile-desktop') -and $round.private)
} finally {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

if ($script:failed -gt 0) { throw "$script:failed 个用例失败" }
'profile-manifest: 全部通过'
