# 清理 release.yml 工作流的所有历史运行 (Windows PowerShell)
# 用法: .\scripts\cleanup-workflow-runs.ps1

param(
    [string]$Owner = "CMDRKilmer",
    [string]$Repo = "RUNCN",
    [string]$Workflow = "release.yml"
)

Write-Host "🗑️  开始清理 $Workflow 的所有历史运行..." -ForegroundColor Cyan
Write-Host ""

# 检查 gh CLI 是否已安装
$ghVersion = gh --version 2>$null
if ($null -eq $ghVersion) {
    Write-Host "❌ 错误：未找到 gh CLI 工具" -ForegroundColor Red
    Write-Host "请先安装: https://cli.github.com/" -ForegroundColor Yellow
    exit 1
}

Write-Host "✓ 已检测到 gh CLI" -ForegroundColor Green
Write-Host ""

# 获取所有工作流运行
Write-Host "正在获取工作流运行列表..." -ForegroundColor Cyan
$runs = gh run list `
    --repo "$Owner/$Repo" `
    --workflow "$Workflow" `
    --limit 100 `
    --json databaseId `
    --jq '.[].databaseId' 2>$null

if ($null -eq $runs -or $runs.Count -eq 0) {
    Write-Host "✅ 没有工作流运行需要清理" -ForegroundColor Green
    exit 0
}

$runList = $runs | Where-Object { $_ -ne "" }
$total = $runList.Count
$deleted = 0

Write-Host "找到 $total 个工作流运行，开始删除..." -ForegroundColor Yellow
Write-Host ""

foreach ($runId in $runList) {
    Write-Host -NoNewline "删除运行 ID: $runId ... "
    try {
        gh run delete $runId --repo "$Owner/$Repo" 2>$null
        Write-Host "✅" -ForegroundColor Green
        $deleted++
    }
    catch {
        Write-Host "❌ (可能已删除)" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "🎉 清理完成！已删除 $deleted/$total 个工作流运行" -ForegroundColor Green
