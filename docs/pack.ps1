# ============================================================
#   MSP-2D 官网 —— 游戏打包脚本
#
#   用法：
#     .\pack.ps1                       打包到 下载/msp2d.zip
#     .\pack.ps1 -Version 1.2.0        带版本号
#
#   做的事：
#     1. 从游戏项目目录复制（排除 .git / __pycache__ / 存档文件）
#     2. 压成 msp2d.zip
#     3. 放到本目录下，官网的下载按钮直接指向它
# ============================================================

param(
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"

# ---- 路径 ----
$SiteDir = $PSScriptRoot
# 游戏项目目录（docs/ 的上一级）
$GameDir = Split-Path $SiteDir -Parent

if (-not (Test-Path $GameDir)) {
    Write-Host "❌ 找不到游戏目录: $GameDir" -ForegroundColor Red
    exit 1
}

# ---- 输出文件名 ----
$zipName = if ($Version) { "msp2d-$Version.zip" } else { "msp2d.zip" }
$zipPath = Join-Path $SiteDir $zipName

# ---- 临时目录 ----
$tmpRoot = Join-Path $env:TEMP ("msp2d-pack-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$tmpDir = Join-Path $tmpRoot "msp2d"
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

Write-Host ""
Write-Host "============================================" -ForegroundColor White
Write-Host "  打包 MSP-2D 游戏" -ForegroundColor White
Write-Host "============================================" -ForegroundColor White
Write-Host ""

# ---- 要排除的东西 ----
$excludeDirs = @('.git', '__pycache__', 'node_modules', '.vscode',
                'docs', 'backups')   # docs 是官网目录，里面就有 zip 本身；backups 是更新前的存档备份
$excludeFiles = @('savegame.json', 'ship.json', 'clients.json', 'shared-state.json',
                  '.DS_Store', 'Thumbs.db')

# ---- 复制文件 ----
$copied = 0
$skipped = 0

Get-ChildItem $GameDir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($GameDir.Length).TrimStart('\', '/')

    # 排除目录
    $inExcluded = $false
    $parts = $rel -split '[\\/]'
    foreach ($d in $excludeDirs) {
        if ($parts -contains $d) { $inExcluded = $true; break }
    }
    # 排除文件
    if (-not $inExcluded -and $excludeFiles -contains $_.Name) { $inExcluded = $true }

    if ($inExcluded) {
        $skipped++
        return
    }

    $dest = Join-Path $tmpDir $rel
    $destDir = Split-Path $dest -Parent
    if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
    Copy-Item $_.FullName -Destination $dest -Force
    $copied++
}

Write-Host "  复制文件: $copied 个（跳过 $skipped 个）" -ForegroundColor Green

# ---- 加一个「怎么玩」的说明文件 ----
$readme = @'
MSP-2D —— Meows Space Project 2D
================================

怎么玩
------

1. 装 Python（如果电脑还没装）：https://www.python.org/downloads/
   安装时记得勾选「Add Python to PATH」

2. 打开命令行（Windows 按 Win+R，输入 cmd 回车）

3. 进入这个文件夹，运行：
       python server.py

4. 浏览器会自动打开，或者手动访问：
       http://localhost:8080/play-main.html

5. 同一个 WiFi 下，手机也能玩：
       http://你的电脑IP:8080/play-main.html

   电脑IP 在 server.py 启动时会打印出来。

操作
----

   E        点火 / 关机
   A D      左转 / 右转
   ↑ ↓      油门（按住 Shift 微调）
   [ ]      缩放（或滚轮）
   空格     分级 / 切断下一级
   P        展开 / 切断降落伞
   . ,      加速 / 减速时间
   V        切换航天器
   S L      存档 / 读档
   C        成就列表
   R        重置这一趟
   M        背景音乐
   ESC      暂停菜单

团队
----

   NotNormal
   B站：https://space.bilibili.com/258037329
   源码：https://github.com/zhaoqianrun/msp-2d
'@
[System.IO.File]::WriteAllText((Join-Path $tmpDir "README.txt"),
    $readme, (New-Object System.Text.UTF8Encoding($true)))

# ---- 压缩 ----
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $tmpRoot,
    $zipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
)

# ---- 清理 ----
Remove-Item $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue

# ---- 结果 ----
$size = (Get-Item $zipPath).Length
$sizeText = if ($size -gt 1MB) { "$([math]::Round($size/1MB,2)) MB" } else { "$([math]::Round($size/1KB,0)) KB" }

Write-Host ""
Write-Host "============================================" -ForegroundColor White
Write-Host "  ✅ 打包完成" -ForegroundColor Green
Write-Host ""
Write-Host "  文件: $zipName" -ForegroundColor White
Write-Host "  大小: $sizeText" -ForegroundColor White
Write-Host "  位置: $zipPath" -ForegroundColor White
Write-Host "============================================" -ForegroundColor White
Write-Host ""
