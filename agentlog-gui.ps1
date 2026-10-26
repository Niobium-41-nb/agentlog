#Requires -Version 5.1
<#
.SYNOPSIS
    agentlog 图形界面：采集工作区内各类 AI Agent 的对话日志。

.DESCRIPTION
    纯 Windows 原生实现：
      - 界面：System.Windows.Forms（Windows 自带 .NET Framework，内部即 User32 / ComCtl32 原生控件）
      - 目录选择：Shell 原生 FolderBrowserDialog
      - 打开文件/文件夹：ShellExecute（Windows 资源管理器默认关联程序）
      - 可选：SetProcessDpiAwarenessContext（user32.dll 原生调用，高分屏文字不模糊）
    不依赖浏览器内核、Electron、任何第三方 UI 库或 NuGet 包。

    采集引擎复用同目录的 agentlog.mjs（需要 Node.js 22.5+）。

.PARAMETER SelfTest
    只做环境自检（Node 定位、脚本路径、各 Agent 存储目录），不开窗口。

.PARAMETER SmokeTest
    构建全部界面控件但不显示窗口，用于验证布局代码可正常执行。

.PARAMETER Export
    无界面导出指定工作区，用于命令行验证。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File agentlog-gui.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File agentlog-gui.ps1 -Export "D:\my project"
#>
param(
    [string]$Workspace = '',
    [switch]$SelfTest,
    [switch]$SmokeTest,
    [switch]$SmokeShow,
    [string]$Snapshot = '',
    [string]$Export = '',
    # 由 agentlog.exe 传入：直接用这个可执行文件当采集引擎（无需本机装 Node.js）
    [string]$EngineExe = ''
)

$ErrorActionPreference = 'Stop'
$script:ScriptDir = $PSScriptRoot
$script:CliPath = Join-Path $PSScriptRoot 'agentlog.mjs'
$script:SettingsPath = Join-Path $env:APPDATA 'agentlog\gui-settings.json'
$script:LastAutoOut = ''
$script:Running = $false
$script:AutoCloseMs = 0
$script:EngineExePath = ''

# 若外部传入了独立可执行文件（agentlog.exe），则改用它驱动，本机无需 Node.js
if ($EngineExe -and (Test-Path -LiteralPath $EngineExe)) {
    $script:EngineExePath = (Resolve-Path -LiteralPath $EngineExe).Path
    $script:CliPath = $script:EngineExePath
}

# ─────────────────────────── 原生 API 装载 ───────────────────────────

[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')
[void][System.Reflection.Assembly]::LoadWithPartialName('System.Drawing')

# 说明：不强制声明 DPI 感知，由 Windows 统一缩放窗口，避免高 DPI 下字体被放大到布局失真。

$script:Agents = @(
    @{ Id = 'workbuddy';        Name = 'WorkBuddy' }
    @{ Id = 'deepseek-harness'; Name = 'DeepSeek Harness' }
    @{ Id = 'opencode';         Name = 'opencode' }
    @{ Id = 'qoder';            Name = 'Qoder' }
    @{ Id = 'copilot';          Name = 'GitHub Copilot' }
    @{ Id = 'copilot-cli';      Name = 'Copilot CLI' }
    @{ Id = 'claude-code';      Name = 'Claude Code' }
)

# ─────────────────────────── 基础工具 ───────────────────────────

function Resolve-NodePath {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }

    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
        (Join-Path $env:APPDATA 'npm\node.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    return ''
}

function Format-ArgList {
    param([string[]]$Items)
    ($Items | ForEach-Object {
        if ($_ -match '\s') { '"' + $_ + '"' } else { $_ }
    }) -join ' '
}

function Get-DefaultOutDir {
    param([string]$Ws)
    if ([string]::IsNullOrWhiteSpace($Ws)) { return '' }
    return (Join-Path $Ws '.agent-logs')
}

function ConvertTo-LocalTime {
    param($IsoText)
    if ([string]::IsNullOrWhiteSpace($IsoText)) { return '' }
    try {
        return ([datetime]$IsoText).ToLocalTime().ToString('yyyy-MM-dd HH:mm')
    } catch {
        return [string]$IsoText
    }
}

# ─────────────────────────── 调用采集引擎 ───────────────────────────

function Invoke-AgentlogEngine {
    <#
        调用 node agentlog.mjs，同步等待并把输出读回来。
        等待期间持续 DoEvents，保证窗口不假死。
    #>
    param(
        [Parameter(Mandatory)][string[]]$CliArgs,
        [scriptblock]$OnTick
    )

    if ($script:EngineExePath) {
        # 独立可执行模式：引擎就是 agentlog.exe 自身
        $psi0 = New-Object System.Diagnostics.ProcessStartInfo
        $psi0.FileName = $script:EngineExePath
        $psi0.Arguments = Format-ArgList $CliArgs
    } else {
        $node = Resolve-NodePath
        if (-not $node) { throw '未找到 Node.js。请先安装 Node.js 22.5 或更高版本：https://nodejs.org' }
        if (-not (Test-Path -LiteralPath $script:CliPath)) { throw "找不到采集引擎：$($script:CliPath)" }
        $psi0 = New-Object System.Diagnostics.ProcessStartInfo
        $psi0.FileName = $node
        # 统一由 Format-ArgList 负责加引号，避免出现双重引号
        $psi0.Arguments = Format-ArgList (@('--no-warnings', $script:CliPath) + $CliArgs)
    }

    $psi = $psi0
    $psi.WorkingDirectory = $script:ScriptDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()

    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()

    while (-not $proc.HasExited) {
        [System.Windows.Forms.Application]::DoEvents()
        if ($OnTick) { & $OnTick }
        Start-Sleep -Milliseconds 60
    }

    $stdout = ''
    $stderr = ''
    try { $stdout = $outTask.Result } catch { }
    try { $stderr = $errTask.Result } catch { }
    $code = $proc.ExitCode
    $proc.Dispose()

    return [pscustomobject]@{
        ExitCode = $code
        StdOut   = $stdout
        StdErr   = $stderr
        Command  = $(if ($script:EngineExePath) { ('agentlog ' + (Format-ArgList $CliArgs)) } else { ('node ' + (Format-ArgList (@("$($script:CliPath)") + $CliArgs))) })
    }
}

function Read-ExportResult {
    <# 读取 sessions.json 与 transcripts，配对成列表项 #>
    param([Parameter(Mandatory)][string]$OutDir)

    $jsonPath = Join-Path $OutDir 'sessions.json'
    if (-not (Test-Path -LiteralPath $jsonPath)) { return @() }

    $text = [System.IO.File]::ReadAllText($jsonPath, [System.Text.Encoding]::UTF8)
    $data = $text | ConvertFrom-Json

    $transcriptDir = Join-Path $OutDir 'transcripts'
    $files = @()
    if (Test-Path -LiteralPath $transcriptDir) {
        $files = @(Get-ChildItem -LiteralPath $transcriptDir -Filter '*.md' -File | Sort-Object Name)
    }

    $rows = @()
    $index = 0
    foreach ($s in @($data.sessions)) {
        $index++
        $file = ''
        if ($index -le $files.Count) { $file = $files[$index - 1].FullName }
        $turns = 0
        $tools = 0
        if ($s.stats) {
            $turns = [int]$s.stats.userTurns
            $tools = [int]$s.stats.tools
        }
        $rows += [pscustomobject]@{
            Index     = $index
            Agent     = [string]$s.agentLabel
            Title     = [string]$s.title
            StartTime = (ConvertTo-LocalTime $s.startedAt)
            Turns     = $turns
            Tools     = $tools
            File      = $file
            Source    = [string]$s.sourceFile
        }
    }
    return $rows
}

# ─────────────────────────── 界面构建 ───────────────────────────

# 按字体实际像素高度换算界面尺寸：96 DPI 下 9pt 微软雅黑字高 16px，作为 1.0 基准
function S {
    param([double]$v)
    return [int][Math]::Round($v * $script:Scale)
}

function New-Ui {
    $font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
    $script:Scale = 1.0
    if ($font.Height -gt 0) { $script:Scale = [double]$font.Height / 16.0 }

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'agentlog · 工作区 AI 对话记录'
    $form.StartPosition = 'CenterScreen'
    $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
    $form.Font = $font
    $form.ClientSize = New-Object System.Drawing.Size((S 1040), (S 760))
    $form.MinimumSize = New-Object System.Drawing.Size((S 900), (S 640))

    # 屏幕保护：窗口不得超出工作区，最小尺寸也不超过屏幕
    $work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    if ($work.Width -gt 0) {
        $maxW = $work.Width - (S 16)
        $maxH = $work.Height - (S 16)
        if ($form.Width -gt $maxW) { $form.Width = $maxW }
        if ($form.Height -gt $maxH) { $form.Height = $maxH }
        $minW = [Math]::Min([int]($form.MinimumSize.Width), $maxW)
        $minH = [Math]::Min([int]($form.MinimumSize.Height), $maxH)
        $form.MinimumSize = New-Object System.Drawing.Size($minW, $minH)
    }

    $root = New-Object System.Windows.Forms.TableLayoutPanel
    $root.Dock = 'Fill'
    $root.ColumnCount = 1
    $root.Padding = New-Object System.Windows.Forms.Padding((S 10))
    [void]$root.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
    for ($i = 0; $i -lt 4; $i++) {
        [void]$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize)))
    }
    [void]$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
    $form.Controls.Add($root)

    # —— 位置：工作区 / 输出目录 ——
    $boxPath = New-Object System.Windows.Forms.GroupBox
    $boxPath.Text = '位置'
    $boxPath.Dock = 'Top'
    $boxPath.AutoSize = $false
    $boxPath.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, (S 6))

    $pathGrid = New-Object System.Windows.Forms.TableLayoutPanel
    $pathGrid.Dock = 'Top'
    $pathGrid.AutoSize = $true
    $pathGrid.AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
    $pathGrid.ColumnCount = 3
    $pathGrid.RowCount = 2
    $pathGrid.Padding = New-Object System.Windows.Forms.Padding((S 10), (S 4), (S 10), (S 8))
    [void]$pathGrid.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, (S 82))))
    [void]$pathGrid.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
    [void]$pathGrid.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, (S 96))))
    [void]$pathGrid.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, (S 30))))
    [void]$pathGrid.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, (S 30))))

    $lblWs = New-Object System.Windows.Forms.Label
    $lblWs.Text = '工作区'
    $lblWs.TextAlign = 'MiddleLeft'
    $lblWs.Dock = 'Fill'
    $lblWs.Margin = New-Object System.Windows.Forms.Padding(0)

    $txtWs = New-Object System.Windows.Forms.TextBox
    $txtWs.Dock = 'Fill'
    $txtWs.Margin = New-Object System.Windows.Forms.Padding(0, (S 3), (S 8), (S 3))

    $btnWs = New-Object System.Windows.Forms.Button
    $btnWs.Text = '浏览...'
    $btnWs.Dock = 'Fill'
    $btnWs.AutoSize = $true
    $btnWs.AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
    $btnWs.Margin = New-Object System.Windows.Forms.Padding(0, (S 2), 0, (S 2))

    $lblOut = New-Object System.Windows.Forms.Label
    $lblOut.Text = '输出目录'
    $lblOut.TextAlign = 'MiddleLeft'
    $lblOut.Dock = 'Fill'
    $lblOut.Margin = New-Object System.Windows.Forms.Padding(0)

    $txtOut = New-Object System.Windows.Forms.TextBox
    $txtOut.Dock = 'Fill'
    $txtOut.Margin = New-Object System.Windows.Forms.Padding(0, (S 3), (S 8), (S 3))

    $btnOut = New-Object System.Windows.Forms.Button
    $btnOut.Text = '浏览...'
    $btnOut.Dock = 'Fill'
    $btnOut.AutoSize = $true
    $btnOut.AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
    $btnOut.Margin = New-Object System.Windows.Forms.Padding(0, (S 2), 0, (S 2))

    $pathGrid.Controls.Add($lblWs, 0, 0)
    $pathGrid.Controls.Add($txtWs, 1, 0)
    $pathGrid.Controls.Add($btnWs, 2, 0)
    $pathGrid.Controls.Add($lblOut, 0, 1)
    $pathGrid.Controls.Add($txtOut, 1, 1)
    $pathGrid.Controls.Add($btnOut, 2, 1)
    $boxPath.Controls.Add($pathGrid)
    $root.Controls.Add($boxPath, 0, 0)

    # —— Agent 选择 ——
    $boxAgent = New-Object System.Windows.Forms.GroupBox
    $boxAgent.Text = '采集哪些 Agent'
    $boxAgent.Dock = 'Top'
    $boxAgent.AutoSize = $false
    $boxAgent.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, (S 6))

    $flowAgent = New-Object System.Windows.Forms.FlowLayoutPanel
    $flowAgent.Dock = 'Top'
    $flowAgent.AutoSize = $false
    $flowAgent.Padding = New-Object System.Windows.Forms.Padding((S 10), (S 4), (S 10), (S 8))
    $flowAgent.WrapContents = $true
    $agentChecks = @{}
    foreach ($a in $script:Agents) {
        $cb = New-Object System.Windows.Forms.CheckBox
        $cb.Text = $a.Name
        $cb.Tag = $a.Id
        $cb.AutoSize = $true
        $cb.Checked = $true
        $cb.Margin = New-Object System.Windows.Forms.Padding(0, (S 4), (S 20), (S 4))
        $flowAgent.Controls.Add($cb)
        $agentChecks[$a.Id] = $cb
    }
    $boxAgent.Controls.Add($flowAgent)
    $root.Controls.Add($boxAgent, 0, 1)

    # —— 选项 ——
    $boxOpt = New-Object System.Windows.Forms.GroupBox
    $boxOpt.Text = '导出选项'
    $boxOpt.Dock = 'Top'
    $boxOpt.AutoSize = $false
    $boxOpt.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, (S 6))

    function New-OptCheck([string]$text, [bool]$checked, [string]$tip) {
        $c = New-Object System.Windows.Forms.CheckBox
        $c.Text = $text
        $c.AutoSize = $true
        $c.Checked = $checked
        $c.Margin = New-Object System.Windows.Forms.Padding(0, (S 4), (S 18), (S 4))
        if ($tip) {
            $tt = New-Object System.Windows.Forms.ToolTip
            $tt.SetToolTip($c, $tip)
        }
        return $c
    }

    $chkTools = New-OptCheck '含工具调用' $true '把 Agent 执行的命令、读写的文件也一并记录下来'
    $chkRedact = New-OptCheck '脱敏' $true '邮箱、手机号、本机用户名路径打码（API Key / Token 始终自动打码）'
    $chkReason = New-OptCheck '含思考过程' $false '会显著增加篇幅，一般交作业不需要'
    $chkMerge = New-OptCheck '合并时间线' $true '生成跨 Agent 的 timeline.md'

    $chkSince = New-OptCheck '起始时间' $false '只导出该日期之后的会话'
    $dtpSince = New-Object System.Windows.Forms.DateTimePicker
    $dtpSince.Format = 'Custom'
    $dtpSince.CustomFormat = 'yyyy-MM-dd'
    $dtpSince.Width = (S 116)
    $dtpSince.Enabled = $false
    $dtpSince.Value = (Get-Date).AddMonths(-1)
    $dtpSince.Margin = New-Object System.Windows.Forms.Padding(0, (S 2), (S 16), (S 4))

    $chkUntil = New-OptCheck '结束时间' $false '只导出该日期之前的会话'
    $dtpUntil = New-Object System.Windows.Forms.DateTimePicker
    $dtpUntil.Format = 'Custom'
    $dtpUntil.CustomFormat = 'yyyy-MM-dd'
    $dtpUntil.Width = (S 116)
    $dtpUntil.Enabled = $false
    $dtpUntil.Value = Get-Date
    $dtpUntil.Margin = New-Object System.Windows.Forms.Padding(0, (S 2), (S 16), (S 4))

    $flowOpt = New-Object System.Windows.Forms.FlowLayoutPanel
    $flowOpt.Dock = 'Top'
    $flowOpt.AutoSize = $false
    $flowOpt.Padding = New-Object System.Windows.Forms.Padding((S 10), (S 4), (S 10), 0)
    $flowOpt.WrapContents = $false
    $flowOpt.Controls.AddRange(@($chkTools, $chkRedact, $chkReason, $chkMerge))

    $flowDate = New-Object System.Windows.Forms.FlowLayoutPanel
    $flowDate.Dock = 'Top'
    $flowDate.AutoSize = $false
    $flowDate.Padding = New-Object System.Windows.Forms.Padding((S 10), (S 2), (S 10), (S 6))
    $flowDate.WrapContents = $false
    $flowDate.Controls.AddRange(@($chkSince, $dtpSince, $chkUntil, $dtpUntil))

    $optGrid = New-Object System.Windows.Forms.TableLayoutPanel
    $optGrid.Dock = 'Top'
    $optGrid.AutoSize = $true
    $optGrid.AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
    $optGrid.ColumnCount = 1
    $optGrid.RowCount = 2
    [void]$optGrid.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
    [void]$optGrid.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, (S 34))))
    [void]$optGrid.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, (S 34))))
    $optGrid.Controls.Add($flowOpt, 0, 0)
    $optGrid.Controls.Add($flowDate, 0, 1)
    $boxOpt.Controls.Add($optGrid)
    $root.Controls.Add($boxOpt, 0, 2)

    # —— 操作按钮 ——
    $flowBtn = New-Object System.Windows.Forms.FlowLayoutPanel
    $flowBtn.Dock = 'Fill'
    $flowBtn.AutoSize = $true
    $flowBtn.AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
    $flowBtn.Padding = New-Object System.Windows.Forms.Padding((S 2), 0, 0, (S 6))
    $flowBtn.WrapContents = $false

    function New-ToolButton([string]$text, [int]$minWidth) {
        $b = New-Object System.Windows.Forms.Button
        $b.Text = $text
        $b.AutoSize = $true
        $b.AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
        $b.MinimumSize = New-Object System.Drawing.Size($minWidth, (S 30))
        $b.Padding = New-Object System.Windows.Forms.Padding((S 8), 0, (S 8), 0)
        $b.Margin = New-Object System.Windows.Forms.Padding(0, 0, (S 8), 0)
        return $b
    }

    $btnExport = New-ToolButton '导出记录' (S 116)
    $btnOpenOut = New-ToolButton '打开输出目录' (S 120)
    $btnSelfTest = New-ToolButton '环境自检' (S 104)

    $lblStatus = New-Object System.Windows.Forms.Label
    $lblStatus.Text = '就绪'
    $lblStatus.AutoSize = $true
    $lblStatus.Margin = New-Object System.Windows.Forms.Padding((S 8), (S 10), 0, 0)

    $flowBtn.Controls.AddRange(@($btnExport, $btnOpenOut, $btnSelfTest, $lblStatus))
    $root.Controls.Add($flowBtn, 0, 3)

    # —— 结果列表 + 日志 ——
    $split = New-Object System.Windows.Forms.SplitContainer
    $split.Dock = 'Fill'
    $split.Orientation = [System.Windows.Forms.Orientation]::Horizontal
    $split.Margin = New-Object System.Windows.Forms.Padding(0)

    $list = New-Object System.Windows.Forms.ListView
    $list.Dock = 'Fill'
    $list.View = [System.Windows.Forms.View]::Details
    $list.FullRowSelect = $true
    $list.GridLines = $false
    $list.MultiSelect = $false
    $list.HideSelection = $false
    foreach ($h in @('#', 'Agent', '会话标题', '时间', '轮次', '工具')) {
        [void]$list.Columns.Add($h, (S 60))
    }
    $split.Panel1.Controls.Add($list)

    $log = New-Object System.Windows.Forms.RichTextBox
    $log.Dock = 'Fill'
    $log.ReadOnly = $true
    $log.BackColor = [System.Drawing.Color]::White
    $log.BorderStyle = 'FixedSingle'
    $log.Font = New-Object System.Drawing.Font('Consolas', 9)
    $log.WordWrap = $false
    $log.DetectUrls = $false
    $split.Panel2.Controls.Add($log)

    $root.Controls.Add($split, 0, 4)

    # —— 状态栏 ——
    $status = New-Object System.Windows.Forms.StatusStrip
    $statusLabel = New-Object System.Windows.Forms.ToolStripStatusLabel
    $statusLabel.Text = '双击列表中的会话，可用系统默认程序打开对应的 Markdown 记录'
    [void]$status.Items.Add($statusLabel)
    $status.Dock = 'Bottom'
    $form.Controls.Add($status)

    return [pscustomobject]@{
        Form        = $form
        TxtWs       = $txtWs
        TxtOut      = $txtOut
        BtnWs       = $btnWs
        BtnOut      = $btnOut
        AgentChecks = $agentChecks
        ChkTools    = $chkTools
        ChkRedact   = $chkRedact
        ChkReason   = $chkReason
        ChkMerge    = $chkMerge
        ChkSince    = $chkSince
        DtpSince    = $dtpSince
        ChkUntil    = $chkUntil
        DtpUntil    = $dtpUntil
        BtnExport   = $btnExport
        BtnOpenOut  = $btnOpenOut
        BtnSelfTest = $btnSelfTest
        LblStatus   = $lblStatus
        List        = $list
        Log         = $log
        StatusLabel = $statusLabel
        Root        = $root
        Split       = $split
        FlowAgent   = $flowAgent
        FlowOpt     = $flowOpt
        OptGrid     = $optGrid
        FlowDate    = $flowDate
        BoxPath     = $boxPath
        BoxAgent    = $boxAgent
        BoxOpt      = $boxOpt
        PathGrid    = $pathGrid
    }
}

# 求一组控件里最高的"控件高度 + 上下外边距"，用于设定表格行高
function Get-RowHeight {
    param($Controls)
    $max = 0
    foreach ($c in $Controls) {
        if (-not $c) { continue }
        $h = $c.PreferredSize.Height + $c.Margin.Vertical
        if ($h -gt $max) { $max = $h }
    }
    return $max
}

# 统一调整自适应高度：流式面板换行高度 -> 分组框高度 -> 表格行高
function Fit-Layout {
    param($Ui)
    Resize-Flows -Ui $Ui
    $titleH = [int]($Ui.Form.Font.Height + 12)
    if ($Ui.PathGrid -and $Ui.PathGrid.Height -gt 0) {
        $Ui.BoxPath.Height = $Ui.PathGrid.Height + $titleH
    }
    if ($Ui.FlowAgent -and $Ui.FlowAgent.Height -gt 0) {
        $Ui.BoxAgent.Height = $Ui.FlowAgent.Height + $titleH
    }

    # 选项区两行：按子控件首选高度设置行高与面板高度
    $rowOpt = Get-RowHeight -Controls $Ui.FlowOpt.Controls
    $rowDate = Get-RowHeight -Controls $Ui.FlowDate.Controls
    if ($rowOpt -gt 0) {
        $Ui.OptGrid.RowStyles[0].Height = $rowOpt
        $Ui.FlowOpt.Height = $rowOpt
    }
    if ($rowDate -gt 0) {
        $Ui.OptGrid.RowStyles[1].Height = $rowDate
        $Ui.FlowDate.Height = $rowDate
    }

    # 位置区两行：同样按文本框高度自适应
    $rowPath = Get-RowHeight -Controls $Ui.PathGrid.Controls
    if ($rowPath -gt 0) {
        $Ui.PathGrid.RowStyles[0].Height = $rowPath
        $Ui.PathGrid.RowStyles[1].Height = $rowPath
        $Ui.PathGrid.Height = $rowPath * 2 + $Ui.PathGrid.Padding.Vertical
        $Ui.BoxPath.Height = $Ui.PathGrid.Height + $titleH
    }
    if ($Ui.OptGrid -and $Ui.OptGrid.Height -gt 0) {
        $Ui.BoxOpt.Height = $Ui.OptGrid.Height + $titleH
    }
}

# 让流式面板高度随实际宽度自动换行，避免第二行被裁掉
function Resize-Flows {
    param($Ui)
    # 按实际可用宽度模拟换行，算出两排复选框所需高度（随 DPI/字体自动变化）
    foreach ($f in @($Ui.FlowAgent, $Ui.FlowOpt)) {
        if (-not $f) { continue }
        $w = $f.ClientSize.Width
        if ($w -le 60 -and $f.Parent) { $w = $f.Parent.ClientSize.Width - 24 }
        if ($w -le 60) { continue }
        $pad = $f.Padding
        $avail = $w - $pad.Horizontal - 6
        $rowW = 0
        $rows = 1
        $rowH = 0
        foreach ($c in $f.Controls) {
            $cw = $c.PreferredSize.Width + $c.Margin.Horizontal
            $ch = $c.PreferredSize.Height + $c.Margin.Vertical
            if ($ch -gt $rowH) { $rowH = $ch }
            if ($rowW -gt 0 -and ($rowW + $cw) -gt $avail) {
                $rows++
                $rowW = $cw
            } else {
                $rowW += $cw
            }
        }
        $h = $pad.Vertical + ($rows * $rowH) + 2
        if ($f.Height -ne $h) { $f.Height = $h }
    }
}

# ListView 列宽按 DPI 缩放，标题列吃掉剩余宽度
function Set-ListColumns {
    param($Ui)
    $k = 1.0
    if ($script:Scale -gt 0) { $k = $script:Scale }
    $idx = [int](46 * $k)
    $agent = [int](176 * $k)
    $time = [int](148 * $k)
    $num = [int](72 * $k)
    if ($Ui.List.Columns.Count -lt 6) { return }
    $avail = $Ui.List.ClientSize.Width - $idx - $agent - $time - $num * 2 - 8
    $title = [Math]::Max([int](240 * $k), $avail)
    $Ui.List.Columns[0].Width = $idx
    $Ui.List.Columns[1].Width = $agent
    $Ui.List.Columns[2].Width = $title
    $Ui.List.Columns[3].Width = $time
    $Ui.List.Columns[4].Width = $num
    $Ui.List.Columns[5].Width = $num
}

# ─────────────────────────── 设置持久化 ───────────────────────────

function Import-GuiSettings {
    if (-not (Test-Path -LiteralPath $script:SettingsPath)) { return $null }
    try {
        $raw = [System.IO.File]::ReadAllText($script:SettingsPath, [System.Text.Encoding]::UTF8)
        return $raw | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Save-GuiSettings {
    param($Ui)
    try {
        $dir = Split-Path -Parent $script:SettingsPath
        if (-not (Test-Path -LiteralPath $dir)) {
            [void][System.IO.Directory]::CreateDirectory($dir)
        }
        $agents = @()
        foreach ($k in $Ui.AgentChecks.Keys) {
            if ($Ui.AgentChecks[$k].Checked) { $agents += $k }
        }
        $obj = [pscustomobject]@{
            version   = 1
            workspace = $Ui.TxtWs.Text
            outDir    = $Ui.TxtOut.Text
            agents    = $agents
            tools     = $Ui.ChkTools.Checked
            redact    = $Ui.ChkRedact.Checked
            reasoning = $Ui.ChkReason.Checked
            merge     = $Ui.ChkMerge.Checked
            width     = [int]($Ui.Form.Width / $script:Scale)
            height    = [int]($Ui.Form.Height / $script:Scale)
        }
        $json = $obj | ConvertTo-Json -Depth 4
        [System.IO.File]::WriteAllText($script:SettingsPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        # 设置保存失败不应影响主流程
    }
}

# ─────────────────────────── 主交互逻辑 ───────────────────────────

function Add-LogLine {
    param($Ui, [string]$Text, [string]$Kind = 'info')
    $color = [System.Drawing.Color]::Black
    switch ($Kind) {
        'ok'    { $color = [System.Drawing.Color]::FromArgb(0, 110, 40) }
        'warn'  { $color = [System.Drawing.Color]::FromArgb(170, 90, 0) }
        'error' { $color = [System.Drawing.Color]::FromArgb(175, 30, 30) }
        'cmd'   { $color = [System.Drawing.Color]::FromArgb(70, 70, 70) }
    }
    $Ui.Log.SelectionStart = $Ui.Log.TextLength
    $Ui.Log.SelectionLength = 0
    $Ui.Log.SelectionColor = $color
    $Ui.Log.AppendText(('[{0}] {1}{2}' -f (Get-Date).ToString('HH:mm:ss'), $Text, [Environment]::NewLine))
    $Ui.Log.SelectionColor = $Ui.Log.ForeColor
    $Ui.Log.ScrollToCaret()
}

function Set-Busy {
    param($Ui, [bool]$Busy, [string]$Text = '')
    $script:Running = $Busy
    foreach ($c in @($Ui.BtnExport, $Ui.BtnOpenOut, $Ui.BtnSelfTest)) { $c.Enabled = -not $Busy }
    if ($Text) { $Ui.LblStatus.Text = $Text }
    $Ui.Form.Cursor = if ($Busy) { [System.Windows.Forms.Cursors]::AppStarting } else { [System.Windows.Forms.Cursors]::Default }
}

function Get-CliArgs {
    param($Ui)
    $cli = @()
    $ws = $Ui.TxtWs.Text.Trim()
    if (-not $ws) { throw '请先选择工作区目录。' }
    if (-not (Test-Path -LiteralPath $ws)) { throw "工作区目录不存在：$ws" }

    $cli += $ws

    $out = $Ui.TxtOut.Text.Trim()
    if ($out) {
        $cli += @('-o', $out)
    }

    $picked = @()
    foreach ($k in $Ui.AgentChecks.Keys) {
        if ($Ui.AgentChecks[$k].Checked) { $picked += $k }
    }
    if ($picked.Count -eq 0) { throw '至少要勾选一个 Agent。' }
    $cli += @('--agents', ($picked -join ','))

    if (-not $Ui.ChkTools.Checked) { $cli += '--no-tools' }
    if ($Ui.ChkRedact.Checked) { $cli += '--redact' }
    if ($Ui.ChkReason.Checked) { $cli += '--reasoning' }
    if (-not $Ui.ChkMerge.Checked) { $cli += '--no-merge' }
    if ($Ui.ChkSince.Checked) { $cli += @('--since', $Ui.DtpSince.Value.ToString('yyyy-MM-dd')) }
    if ($Ui.ChkUntil.Checked) { $cli += @('--until', $Ui.DtpUntil.Value.ToString('yyyy-MM-dd')) }

    return $cli
}

function Update-List {
    param($Ui, [string]$OutDir)
    $Ui.List.BeginUpdate()
    try {
        $Ui.List.Items.Clear()
        $rows = @(Read-ExportResult -OutDir $OutDir)
        foreach ($r in $rows) {
            $item = New-Object System.Windows.Forms.ListViewItem([string]$r.Index)
            [void]$item.SubItems.Add($r.Agent)
            [void]$item.SubItems.Add($r.Title)
            [void]$item.SubItems.Add($r.StartTime)
            [void]$item.SubItems.Add([string]$r.Turns)
            [void]$item.SubItems.Add([string]$r.Tools)
            $item.Tag = $r
            [void]$Ui.List.Items.Add($item)
        }
        if ($Ui.List.Columns.Count -ge 3) { $Ui.List.AutoResizeColumn(2, [System.Windows.Forms.ColumnHeaderAutoResizeStyle]::None) }
        return $rows.Count
    } finally {
        $Ui.List.EndUpdate()
    }
}

function Invoke-ExportUi {
    param($Ui)
    if ($script:Running) { return }
    try {
        $cliArgs = Get-CliArgs -Ui $Ui
    } catch {
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'agentlog', 'OK', 'Warning') | Out-Null
        return
    }

    $ws = $Ui.TxtWs.Text.Trim()
    $outDir = $Ui.TxtOut.Text.Trim()
    if (-not $outDir) { $outDir = Get-DefaultOutDir -Ws $ws }

    Set-Busy -Ui $Ui -Busy $true -Text '正在采集...'
    $Ui.Log.Clear()
    Add-LogLine -Ui $Ui -Text ('工作区：' + $ws) -Kind 'info'
    Add-LogLine -Ui $Ui -Text ('等价命令：node agentlog.mjs ' + (Format-ArgList $cliArgs)) -Kind 'cmd'

    try {
        $res = Invoke-AgentlogEngine -CliArgs $cliArgs
        foreach ($line in ($res.StdOut -split "`r?`n")) {
            if ($line.Trim()) { Add-LogLine -Ui $Ui -Text $line -Kind 'info' }
        }
        foreach ($line in ($res.StdErr -split "`r?`n")) {
            if ($line.Trim()) { Add-LogLine -Ui $Ui -Text $line -Kind 'warn' }
        }

        if ($res.ExitCode -ne 0) {
            Add-LogLine -Ui $Ui -Text ("采集失败，退出码 $($res.ExitCode)") -Kind 'error'
            $Ui.LblStatus.Text = '失败'
            [System.Windows.Forms.MessageBox]::Show('采集失败，详情见下方日志。', 'agentlog', 'OK', 'Error') | Out-Null
            return
        }

        $count = Update-List -Ui $Ui -OutDir $outDir
        if ($count -eq 0) {
            Add-LogLine -Ui $Ui -Text '该工作区没有找到对话记录。可用「环境自检」确认各 Agent 日志目录是否存在。' -Kind 'warn'
            $Ui.LblStatus.Text = '未找到记录'
        } else {
            Add-LogLine -Ui $Ui -Text ("完成：$count 个会话已导出到 $outDir") -Kind 'ok'
            $Ui.LblStatus.Text = "完成：$count 个会话"
            $Ui.StatusLabel.Text = $outDir
        }
    } catch {
        Add-LogLine -Ui $Ui -Text $_.Exception.Message -Kind 'error'
        $Ui.LblStatus.Text = '出错'
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'agentlog', 'OK', 'Error') | Out-Null
    } finally {
        Set-Busy -Ui $Ui -Busy $false
    }
}

function Invoke-SelfTestUi {
    param($Ui)
    if ($script:Running) { return }
    Set-Busy -Ui $Ui -Busy $true -Text '自检中...'
    $Ui.Log.Clear()
    try {
        $res = Invoke-AgentlogEngine -CliArgs @('--self-test')
        foreach ($line in (($res.StdOut + "`n" + $res.StdErr) -split "`r?`n")) {
            if ($line.Trim()) { Add-LogLine -Ui $Ui -Text $line }
        }
        Add-LogLine -Ui $Ui -Text ('引擎：' + $script:CliPath) -Kind 'cmd'
        $Ui.LblStatus.Text = '自检完成'
    } catch {
        Add-LogLine -Ui $Ui -Text $_.Exception.Message -Kind 'error'
        $Ui.LblStatus.Text = '自检失败'
    } finally {
        Set-Busy -Ui $Ui -Busy $false
    }
}

function Open-PathNative {
    param([string]$Target)
    if (-not $Target) { return }
    if (-not (Test-Path -LiteralPath $Target)) {
        [System.Windows.Forms.MessageBox]::Show("路径不存在：$Target", 'agentlog', 'OK', 'Warning') | Out-Null
        return
    }
    # ShellExecute：交给 Windows 默认关联程序打开（原生行为）
    Start-Process -FilePath $Target
}

# ─────────────────────────── 入口 ───────────────────────────

function Show-MainWindow {
    param([string]$InitialWorkspace)

    $ui = New-Ui
    $form = $ui.Form
    $form.Icon = [System.Drawing.SystemIcons]::Application

    # 默认值 / 上次设置
    $saved = Import-GuiSettings
    if ($InitialWorkspace) {
        $ui.TxtWs.Text = $InitialWorkspace
    } elseif ($saved -and $saved.workspace) {
        $ui.TxtWs.Text = $saved.workspace
    } else {
        $ui.TxtWs.Text = (Get-Location).Path
    }
    $ui.TxtOut.Text = Get-DefaultOutDir -Ws $ui.TxtWs.Text
    $script:LastAutoOut = $ui.TxtOut.Text

    if ($saved) {
        if ($saved.agents) {
            foreach ($k in $ui.AgentChecks.Keys) {
                $ui.AgentChecks[$k].Checked = ($saved.agents -contains $k)
            }
        }
        if ($saved.PSObject.Properties.Name -contains 'tools') { $ui.ChkTools.Checked = [bool]$saved.tools }
        if ($saved.PSObject.Properties.Name -contains 'redact') { $ui.ChkRedact.Checked = [bool]$saved.redact }
        if ($saved.PSObject.Properties.Name -contains 'reasoning') { $ui.ChkReason.Checked = [bool]$saved.reasoning }
        if ($saved.PSObject.Properties.Name -contains 'merge') { $ui.ChkMerge.Checked = [bool]$saved.merge }
        $hasSize = ($saved.PSObject.Properties.Name -contains 'version') -and ([int]$saved.version -eq 1)
        if ($hasSize -and $saved.width -and $saved.height) {
            $w = [int]$saved.width
            $h = [int]$saved.height
            $work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
            if ($w -ge (S 700) -and $h -ge (S 520) -and $w -le $work.Width -and $h -le $work.Height) {
                $form.Width = (S $w)
                $form.Height = (S $h)
            }
        }
        if ($saved.outDir) {
            $ui.TxtOut.Text = $saved.outDir
            $script:LastAutoOut = ''
        }
    }

    # —— 事件 ——
    $ui.BtnWs.Add_Click({
        $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
        $dlg.Description = '选择要采集对话记录的工作区目录'
        $dlg.ShowNewFolderButton = $false
        if ($ui.TxtWs.Text -and (Test-Path -LiteralPath $ui.TxtWs.Text)) { $dlg.SelectedPath = $ui.TxtWs.Text }
        if ($dlg.ShowDialog() -eq 'OK') {
            $ui.TxtWs.Text = $dlg.SelectedPath
            $ui.TxtOut.Text = Get-DefaultOutDir -Ws $dlg.SelectedPath
            $script:LastAutoOut = $ui.TxtOut.Text
        }
        $dlg.Dispose()
    })

    $ui.BtnOut.Add_Click({
        $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
        $dlg.Description = '选择导出目录'
        $dlg.ShowNewFolderButton = $true
        if ($ui.TxtOut.Text -and (Test-Path -LiteralPath $ui.TxtOut.Text)) { $dlg.SelectedPath = $ui.TxtOut.Text }
        if ($dlg.ShowDialog() -eq 'OK') { $ui.TxtOut.Text = $dlg.SelectedPath }
        $dlg.Dispose()
    })

    $ui.TxtWs.Add_TextChanged({
        $auto = Get-DefaultOutDir -Ws $ui.TxtWs.Text
        if (-not $ui.TxtOut.Text -or $ui.TxtOut.Text -eq $script:LastAutoOut) {
            $ui.TxtOut.Text = $auto
            $script:LastAutoOut = $auto
        }
    })

    $ui.ChkSince.Add_CheckedChanged({ $ui.DtpSince.Enabled = $ui.ChkSince.Checked })
    $ui.ChkUntil.Add_CheckedChanged({ $ui.DtpUntil.Enabled = $ui.ChkUntil.Checked })

    $ui.BtnExport.Add_Click({ Invoke-ExportUi -Ui $ui })
    $ui.BtnSelfTest.Add_Click({ Invoke-SelfTestUi -Ui $ui })
    $ui.BtnOpenOut.Add_Click({
        $outDir = $ui.TxtOut.Text.Trim()
        if (-not $outDir) { $outDir = Get-DefaultOutDir -Ws $ui.TxtWs.Text.Trim() }
        Open-PathNative $outDir
    })

    $ui.List.Add_DoubleClick({
        if ($ui.List.SelectedItems.Count -eq 0) { return }
        $row = $ui.List.SelectedItems[0].Tag
        if ($row -and $row.File) {
            Open-PathNative $row.File
        } else {
            [System.Windows.Forms.MessageBox]::Show('该会话没有对应的 Markdown 文件。', 'agentlog', 'OK', 'Information') | Out-Null
        }
    })

    $form.Add_FormClosing({ Save-GuiSettings -Ui $ui })
    $form.Add_Shown({
        Add-LogLine -Ui $ui -Text '选择工作区后点击「导出记录」。首次使用建议先点「环境自检」。'
        Add-LogLine -Ui $ui -Text '本界面仅使用 Windows 自带组件，无需浏览器或第三方运行库。' -Kind 'cmd'
        Fit-Layout -Ui $ui
        Set-ListColumns -Ui $ui
    try { $ui.Split.Panel1MinSize = (S 90) } catch { }
    try { $ui.Split.Panel2MinSize = (S 70) } catch { }
        try {
            $h = $ui.Split.Height
            $min = $ui.Split.Panel1MinSize + $ui.Split.Panel2MinSize + 10
            if ($h -gt $min) { $ui.Split.SplitterDistance = [int]($h * 0.5) }
        } catch { }
    })

    $form.Add_Resize({
        Fit-Layout -Ui $ui
        Set-ListColumns -Ui $ui
    })

    # 自动化验证用：显示窗口并在指定毫秒后自动关闭
    if ($script:AutoCloseMs -gt 0) {
        $timer = New-Object System.Windows.Forms.Timer
        $timer.Interval = $script:AutoCloseMs
        $timer.Add_Tick({
            $timer.Stop()
            $form.Close()
        })
        $form.Add_Shown({ $timer.Start() })
    }

    [void]$form.ShowDialog()
    $form.Dispose()
}

# —— 命令行模式 ——

if ($SelfTest) {
    Write-Output 'agentlog 图形界面 · 环境自检'
    Write-Output ('  PowerShell      : ' + $PSVersionTable.PSVersion.ToString())
    Write-Output ('  线程模型        : ' + [System.Threading.Thread]::CurrentThread.ApartmentState)
    Write-Output ('  界面库          : ' + [System.Windows.Forms.Application]::ProductVersion + '（Windows 自带）')
    Write-Output ('  脚本目录        : ' + $script:ScriptDir)
    Write-Output ('  采集引擎        : ' + $script:CliPath + ' 存在=' + (Test-Path -LiteralPath $script:CliPath))
    if ($script:EngineExePath) {
        Write-Output ('  Node.js         : 不需要（已内置于 ' + $script:EngineExePath + '）')
    } else {
        $nodePath = Resolve-NodePath
        Write-Output ('  Node.js         : ' + $(if ($nodePath) { $nodePath } else { '未找到（请安装 Node.js 22.5+）' }))
    }
    if (($script:EngineExePath) -or ($nodePath -and (Test-Path -LiteralPath $script:CliPath))) {
        $res = Invoke-AgentlogEngine -CliArgs @('--self-test')
        Write-Output '  —— 引擎自检 ——'
        foreach ($line in (($res.StdOut + $res.StdErr) -split "`r?`n")) {
            if ($line.Trim()) { Write-Output ('  ' + $line) }
        }
    }
    exit 0
}

if ($SmokeTest) {
    $ui = New-Ui
    $ui.TxtWs.Text = (Get-Location).Path
    $ui.TxtOut.Text = Get-DefaultOutDir -Ws $ui.TxtWs.Text
    $ui.Form.CreateControl()
    [void]$ui.Form.PerformLayout()
    Write-Output ('界面构建成功：控件 {0} 个，尺寸 {1}' -f $ui.Form.Controls.Count, $ui.Form.Size.ToString())
    Write-Output ('列表列数 {0}，Agent 选项 {1} 个' -f $ui.List.Columns.Count, $ui.AgentChecks.Count)
    $ui.Form.Dispose()
    exit 0
}

if ($Export) {
    if (-not (Test-Path -LiteralPath $Export)) {
        Write-Error "工作区不存在：$Export"
        exit 2
    }
    $res = Invoke-AgentlogEngine -CliArgs @($Export, '--redact')
    Write-Output $res.StdOut
    if ($res.StdErr) { Write-Output $res.StdErr }
    $outDir = Get-DefaultOutDir -Ws $Export
    $rows = @(Read-ExportResult -OutDir $outDir)
    Write-Output ('解析到会话：{0} 个' -f $rows.Count)
    foreach ($r in $rows) {
        Write-Output ('  #{0} {1} | {2} | {3} | {4} 轮 | {5} 工具 | {6}' -f $r.Index, $r.Agent, $r.Title, $r.StartTime, $r.Turns, $r.Tools, (Split-Path -Leaf $r.File))
    }
    exit $res.ExitCode
}

if ([System.Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') {
    Write-Error '需要 STA 线程。请用 Windows PowerShell（powershell.exe）运行，或加 -Sta 参数。'
    exit 1
}

if ($SmokeShow) {
    $script:AutoCloseMs = 1500
    Show-MainWindow -InitialWorkspace $Workspace
    Write-Output '窗口已正常显示并自动关闭（含设置读写）。'
    exit 0
}

if ($Snapshot) {
    # 自动截图：用于验证布局，导出后状态
    $ui = New-Ui
    $ws = if ($Workspace) { $Workspace } else { (Get-Location).Path }
    $ui.TxtWs.Text = $ws
    $ui.TxtOut.Text = Get-DefaultOutDir -Ws $ws
    $rows = @(Read-ExportResult -OutDir $ui.TxtOut.Text)
    $ui.List.BeginUpdate()
    foreach ($r in $rows) {
        $item = New-Object System.Windows.Forms.ListViewItem([string]$r.Index)
        [void]$item.SubItems.Add($r.Agent)
        [void]$item.SubItems.Add($r.Title)
        [void]$item.SubItems.Add($r.StartTime)
        [void]$item.SubItems.Add([string]$r.Turns)
        [void]$item.SubItems.Add([string]$r.Tools)
        [void]$ui.List.Items.Add($item)
    }
    $ui.List.EndUpdate()
    Add-LogLine -Ui $ui -Text ('工作区：' + $ws)
    Add-LogLine -Ui $ui -Text '等价命令：node agentlog.mjs "D:\Program Files\Agent-logs" --agents workbuddy,... --redact' -Kind 'cmd'
    Add-LogLine -Ui $ui -Text '  探测 WorkBuddy ... 发现 1 个会话'
    Add-LogLine -Ui $ui -Text '  探测 opencode ... 发现 0 个会话'
    Add-LogLine -Ui $ui -Text ("完成：{0} 个会话已导出到 {1}" -f $rows.Count, $ui.TxtOut.Text) -Kind 'ok'
    $ui.LblStatus.Text = "完成：$($rows.Count) 个会话"

    $ui.Form.Show()
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.Application]::DoEvents()
    Fit-Layout -Ui $ui
    Set-ListColumns -Ui $ui
    try { $ui.Split.Panel1MinSize = (S 90) } catch { }
    try { $ui.Split.Panel2MinSize = (S 70) } catch { }
    try {
        $h = $ui.Split.Height
        $min = $ui.Split.Panel1MinSize + $ui.Split.Panel2MinSize + 10
        if ($h -gt $min) { $ui.Split.SplitterDistance = [int]($h * 0.5) }
    } catch { }
    [System.Windows.Forms.Application]::DoEvents()

    $w = $ui.Form.Width
    $h = $ui.Form.Height
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $ui.Form.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle(0, 0, $w, $h)))
    $bmp.Save($Snapshot, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $ui.Form.Close()
    $ui.Form.Dispose()
    Write-Output ('截图已保存：' + $Snapshot)
    exit 0
}

try {
    Show-MainWindow -InitialWorkspace $Workspace
} catch {
    [System.Windows.Forms.MessageBox]::Show(($_.Exception.Message + [Environment]::NewLine + [Environment]::NewLine + $_.ScriptStackTrace), 'agentlog 启动失败', 'OK', 'Error') | Out-Null
    exit 1
}
