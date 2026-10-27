# profile 的 package.json（manifest）里与本插件相关的两处：
#
#   dependencies          → pnpm 装不装、node_modules 里有没有
#   dsh.profile.bundles   → 插件页的开关状态，也是 Loader 应用 bundle patch 的前提
#
# 两处缺一不可，漏掉 bundles 的典型表现：插件页里显示“未启用/没打开”，
# 但旧版本的设置页还在跑（旧依赖名 + 旧 node_modules 链接还在，旧 bundle 仍被加载）。
#
# 被 scripts/install.ps1 dot-source；单测在 scripts/profile-manifest.test.ps1。

$script:LegacyPackageName = 'dsh-mcp-presets'
$script:PackageName = 'dsh-mcp-management'

# 依赖表：去掉两个名字，安装时补上当前名与宿主侧依赖；其它依赖原样保留
function Resolve-ProfileDependencies {
  param(
    [Parameter(Mandatory)][hashtable]$Existing,
    [Parameter(Mandatory)][string]$PluginPath,
    [switch]$Uninstall
  )
  $out = [ordered]@{}
  foreach ($key in $Existing.Keys) {
    if ($key -eq $script:LegacyPackageName -or $key -eq $script:PackageName) { continue }
    $out[$key] = $Existing[$key]
  }
  if (-not $Uninstall) {
    $out[$script:PackageName] = "link:$($PluginPath -replace '\\', '/')"
    if (-not $out.Contains('js-yaml')) { $out['js-yaml'] = '^4.1.0' }
    if (-not $out.Contains('@modelcontextprotocol/sdk')) { $out['@modelcontextprotocol/sdk'] = '^1.32.2' }
  }
  return $out
}

# 组合包选择：保持既有顺序，去掉旧名（和卸载时的当前名），安装时把当前名追加到末尾
# —— 追加在末尾与插件页“开启”的行为一致（优先级最低，不覆盖别处的配置层）
function Resolve-ProfileBundles {
  param(
    [AllowEmptyCollection()][string[]]$Existing = @(),
    [switch]$Uninstall
  )
  $out = [System.Collections.Generic.List[string]]::new()
  foreach ($name in $Existing) {
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    if ($name -eq $script:LegacyPackageName) { continue }
    if ($Uninstall -and $name -eq $script:PackageName) { continue }
    if (-not $out.Contains($name)) { $out.Add($name) }
  }
  if (-not $Uninstall -and -not $out.Contains($script:PackageName)) { $out.Add($script:PackageName) }
  return ,$out.ToArray()
}

# 把 ConvertFrom-Json 出来的 manifest 变成可安全重建的结构
function Read-ProfileManifest {
  param([Parameter(Mandatory)][string]$Path)
  $manifest = Get-Content $Path -Raw | ConvertFrom-Json
  $deps = @{}
  if ($manifest.PSObject.Properties['dependencies'] -and $manifest.dependencies) {
    foreach ($p in $manifest.dependencies.PSObject.Properties) { $deps[$p.Name] = $p.Value }
  }
  $bundles = @()
  if ($manifest.PSObject.Properties['dsh'] -and $manifest.dsh) {
    if ($manifest.dsh.PSObject.Properties['profile'] -and $manifest.dsh.profile) {
      if ($manifest.dsh.profile.PSObject.Properties['bundles'] -and $manifest.dsh.profile.bundles) {
        $bundles = @($manifest.dsh.profile.bundles | ForEach-Object { [string]$_ })
      }
    }
  }
  return [pscustomobject]@{ Manifest = $manifest; Dependencies = $deps; Bundles = $bundles }
}

# 把解析结果写回 manifest 对象（保留其它字段与顺序）
function Write-ProfileManifestShape {
  param(
    [Parameter(Mandatory)]$Manifest,
    [Parameter(Mandatory)]$Dependencies,
    [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Bundles
  )
  if (-not $Manifest.PSObject.Properties['dependencies']) { $Manifest | Add-Member dependencies ([pscustomobject]@{}) }
  $Manifest.dependencies = [pscustomobject]$Dependencies

  if (-not $Manifest.PSObject.Properties['dsh']) { $Manifest | Add-Member dsh ([pscustomobject]@{}) }
  if (-not $Manifest.dsh.PSObject.Properties['profile']) { $Manifest.dsh | Add-Member profile ([pscustomobject]@{}) }
  $Manifest.dsh.profile | Add-Member -Force -NotePropertyName bundles -NotePropertyValue @($Bundles)
  return $Manifest
}
