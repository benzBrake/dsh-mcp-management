# 安装 / 卸载 dsh-mcp-management（link 方式，幂等）
#   pwsh -NoProfile -File scripts\install.ps1              安装 / 更新 / 启用
#   pwsh -NoProfile -File scripts\install.ps1 -Uninstall   卸载（含取消启用）
#   pwsh -NoProfile -File scripts\install.ps1 -DryRun      只打印打算做什么，不落盘、不跑 pnpm
#   pwsh -NoProfile -File scripts\install.ps1 -ProfileName desktop -DshHome D:\dsh
#
# 一个插件要在 DSH 里真正跑起来，profile 的三处必须同时对上：
#   1. package.json  dependencies         → pnpm 装进 node_modules
#   2. package.json  dsh.profile.bundles  → 插件页的开关；也是应用 bundle patch（cordis.patch.yml）的前提
#   3. cordis.patch.yml  的条目           → 插件行的 config（patchFile 等）
# 只改 1 不改 2 的表现：插件页显示“没打开”，但旧版本界面还在 Settings 里（旧依赖名 + 旧 node_modules 链接仍在加载）。
#
# 本插件早先叫 dsh-mcp-presets：本脚本会把 profile 里旧名留下的依赖、bundles 选择、
# insert 行、id 覆盖行原地改名（自定义 config 保留），并清掉指向旧目录的 node_modules 链接。

param(
  [switch]$Uninstall,
  [switch]$DryRun,
  [string]$DshHome = $env:DSH_HOME,
  [string]$ProfileName = $env:DSH_PROFILE
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'patch-lines.ps1')
. (Join-Path $PSScriptRoot 'profile-manifest.ps1')

# 仓库根 = 本脚本所在目录的上一层
$pluginPath = Split-Path -Parent $PSScriptRoot
$pkgJsonPath = Join-Path $pluginPath 'package.json'
if (-not (Test-Path $pkgJsonPath)) { throw "看起来不是插件仓库：$pluginPath 里没有 package.json" }
$pluginPkg = Get-Content $pkgJsonPath -Raw | ConvertFrom-Json
if ($pluginPkg.name -ne $script:PackageName) { throw "包名不是 $($script:PackageName)：$($pluginPkg.name)" }

if ([string]::IsNullOrWhiteSpace($DshHome)) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
if ([string]::IsNullOrWhiteSpace($ProfileName)) { $ProfileName = 'desktop' }
$profileDir = Join-Path $DshHome (Join-Path 'profiles' $ProfileName)
$manifestPath = Join-Path $profileDir 'package.json'
$patchPath = Join-Path $profileDir 'cordis.patch.yml'

# pnpm 的位置随安装方式而变，不写死：$env:DSH_PNPM → DSH 自带 → PATH 里的 pnpm
function Resolve-Pnpm {
  if ($env:DSH_PNPM) {
    if (-not (Test-Path $env:DSH_PNPM)) { throw "DSH_PNPM 指向的文件不存在：$($env:DSH_PNPM)" }
    if ($env:DSH_PNPM -match '\.(c|m)?js$') { return @{ Command = 'node'; Prefix = @($env:DSH_PNPM) } }
    return @{ Command = $env:DSH_PNPM; Prefix = @() }
  }
  $roots = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\primary-runtime'),
    (Join-Path $env:PROGRAMFILES 'DeepSeek Harness\resources\runtime\primary-runtime')
  ) | Where-Object { $_ -and (Test-Path $_) }
  foreach ($root in $roots) {
    $cjsPath = Join-Path $root 'dependencies\pnpm\bin\pnpm.cjs'
    if (Test-Path $cjsPath) { return @{ Command = 'node'; Prefix = @($cjsPath) } }
    $cmdPath = Join-Path $root 'dependencies\pnpm\bin\pnpm.cmd'
    if (Test-Path $cmdPath) { return @{ Command = $cmdPath; Prefix = @() } }
  }
  $onPath = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($onPath) { return @{ Command = $onPath.Source; Prefix = @() } }
  throw '找不到 pnpm：设 $env:DSH_PNPM=<pnpm 可执行文件或 pnpm.cjs 路径>，或把 pnpm 放进 PATH'
}

if (-not (Test-Path $manifestPath)) { throw "找不到 profile：$profileDir（先跑一次 dsh web / 打开一次桌面端）" }
if (-not (Test-Path $patchPath)) { throw "找不到 profile 补丁：$patchPath" }

"profile  : $profileDir"
"plugin   : $pluginPath ($($pluginPkg.version))"

# ── 1. 依赖 + 2. 组合包选择 ──────────────────────────────────────────────────
$read = Read-ProfileManifest -Path $manifestPath
$nextDeps = Resolve-ProfileDependencies -Existing $read.Dependencies -PluginPath $pluginPath -Uninstall:$Uninstall
$nextBundles = Resolve-ProfileBundles -Existing $read.Bundles -Uninstall:$Uninstall
$manifest = Write-ProfileManifestShape -Manifest $read.Manifest -Dependencies $nextDeps -Bundles $nextBundles

"deps     : $($nextDeps.Keys -join ', ')"
if ($Uninstall) {
  "bundles  : 取消选择 $($script:PackageName)"
} elseif (@($read.Bundles) -contains $script:PackageName) {
  "bundles  : 已启用（$($script:PackageName)）"
} elseif (@($read.Bundles) -contains $script:LegacyPackageName) {
  "bundles  : 用 $($script:PackageName) 替换旧名 $($script:LegacyPackageName)（仍排在末尾）"
} else {
  "bundles  : 追加 $($script:PackageName)（共 $(@($nextBundles).Count) 项）"
}

# ── 3. 补丁行：旧名原地改名；缺条目时补一段 ──────────────────────────────────
$text = Get-Content $patchPath -Raw
if ($Uninstall) {
  $nextPatch = Remove-PluginPatchBlock $text
  $patchState = if ($nextPatch -eq $text) { 'patch    : 没有本插件条目，无需删除' } else { 'patch    : 已摘掉 insert 与 id 覆盖块' }
} else {
  $nextPatch = Move-PluginPatchToCurrentName $text
  if (-not (Test-PluginEntryPresent $nextPatch)) {
    $nextPatch = Add-PluginPatchBlock $nextPatch -PatchFile $patchPath
    $patchState = 'patch    : 已追加 mcp-management 条目（insert + config）'
  } elseif ($nextPatch -ne $text) {
    $patchState = 'patch    : 旧条目已改名为 mcp-management（保留原 config）'
  } else {
    $patchState = 'patch    : mcp-management 条目已存在'
  }
}
$patchState
if ($nextPatch -ne $text) {
  $delta = (($nextPatch -split "`r?`n").Count) - (($text -split "`r?`n").Count)
  $sign = if ($delta -ge 0) { '+' } else { '-' }
  "patch    : 行数 $sign$([math]::Abs($delta))"
}

# ── 4. 旧名的 node_modules 链接：留着会让旧 bundle 继续被加载 ─────────────────
$legacyLink = Join-Path $profileDir "node_modules\$($script:LegacyPackageName)"
$legacyLinkItem = if (Test-Path $legacyLink) { Get-Item $legacyLink -Force } else { $null }
if ($legacyLinkItem) { "link     : 待删除旧链接 $($script:LegacyPackageName) -> $($legacyLinkItem.Target)" }

if ($DryRun) {
  '--- DryRun：不写文件、不跑 pnpm。下面的补丁文件就是结果 ---'
  $nextPatch
  exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $manifestPath "$manifestPath.bak-install-$stamp" -Force
Copy-Item $patchPath "$patchPath.bak-install-$stamp" -Force
($manifest | ConvertTo-Json -Depth 12) + "`n" | Set-Content -Path $manifestPath -NoNewline -Encoding utf8
if ($nextPatch -ne $text) { Set-Content -Path $patchPath -Value $nextPatch -NoNewline -Encoding utf8 }

if ($legacyLinkItem) {
  if ($legacyLinkItem.LinkType) {
    Remove-Item $legacyLink -Force
    'link     : 旧链接已删除'
  } else {
    "warn     : $legacyLink 不是符号链接（像是真实目录），跳过删除，请人工确认"
  }
}

# ── pnpm install（link 依赖需要它生成符号链接）────────────────────────────────
$pnpm = Resolve-Pnpm
Push-Location $profileDir
try {
  & $pnpm.Command @($pnpm.Prefix + @('install', '--no-frozen-lockfile', '--config.confirmModulesPurge=false'))
  $pnpmExit = $LASTEXITCODE
} finally { Pop-Location }
if ($pnpmExit -ne 0) { "warn     : pnpm install 退出码 $pnpmExit（清单与补丁已写好，看上面的输出决定是否重跑）" }

$linkPath = Join-Path $profileDir "node_modules\$($script:PackageName)"
if (-not $Uninstall -and (Test-Path $linkPath)) {
  "link     : $linkPath -> $((Get-Item $linkPath -Force).Target)"
}
if (Test-Path $legacyLink) { "warn     : 旧链接还在：$legacyLink" }

if ($Uninstall) {
  "已卸载。重启 DSH 后「MCP」页签消失。备份：*.bak-install-$stamp"
} else {
  "已安装并启用。重启 DSH（profile 没开 HMR，bundles 变更要重启才生效）→ 插件页确认开关为开 → 浏览器硬刷新。备份：*.bak-install-$stamp"
}
