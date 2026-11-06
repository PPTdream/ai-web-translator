param([string]$Browser, [string]$Ext)

$ErrorActionPreference = 'Stop'
try {
  if (-not $Browser) {
    $candidates = @(
      (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
      (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
      (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
    )
    foreach ($p in $candidates) {
      if (Test-Path $p) { $Browser = $p; break }
    }
  }
  if (-not $Browser -or -not (Test-Path $Browser)) {
    throw '没有找到 Edge / Chrome，请手动打开 edge://extensions'
  }
  if (-not $Ext) { $Ext = Join-Path $PSScriptRoot 'extension' }

  $ws = New-Object -ComObject WScript.Shell
  $desktop = [Environment]::GetFolderPath('Desktop')
  $lnkPath = Join-Path $desktop 'AI翻译助手-扩展管理.lnk'
  $lnk = $ws.CreateShortcut($lnkPath)
  $lnk.TargetPath = $Browser
  if ($Browser -match '(?i)chrome') {
    $lnk.Arguments = 'chrome://extensions'
  } else {
    $lnk.Arguments = 'edge://extensions'
  }
  $lnk.WorkingDirectory = Split-Path -Parent $Browser
  $lnk.IconLocation = $Browser + ',0'
  $lnk.Description = '打开扩展管理页，手动加载 AI 网页翻译助手'
  $lnk.Save()

  Write-Host '已创建桌面快捷方式：AI翻译助手-扩展管理.lnk'
  Write-Host '打开后点「加载解压缩的扩展」，选择：'
  Write-Host $Ext
  Start-Sleep -Seconds 2
} catch {
  Write-Host ('快捷方式创建失败：' + $_.Exception.Message)
  Start-Sleep -Seconds 2
}
