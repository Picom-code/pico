# Pico installer for Windows (PowerShell 5.1+). User-level only: no admin, no system changes.
# Writes to $env:PICO_PREFIX (default %LOCALAPPDATA%\Pico) and adds its bin folder to your *user* PATH.
# Your data ($env:PICO_HOME, default ~\.pico) is never touched.
#
#   irm https://raw.githubusercontent.com/Picom-code/pico/main/installer/install.ps1 | iex
#   & ([scriptblock]::Create((irm .../install.ps1))) -Yes -NoWeb -DryRun
#
# Re-running it updates in place. See installer/README.md.
param([switch]$Yes, [switch]$NoWeb, [switch]$DryRun, [switch]$NoModifyPath)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Env-Or([string]$name, [string]$default) { $v = [Environment]::GetEnvironmentVariable($name); if ($v) { $v } else { $default } }

$Repo       = Env-Or 'PICO_REPO' 'https://github.com/Picom-code/pico'
$Ref        = Env-Or 'PICO_REF' 'main'
$SrcLocal   = Env-Or 'PICO_SRC' ''
$Prefix     = Env-Or 'PICO_PREFIX' (Join-Path $env:LOCALAPPDATA 'Pico')
$Data       = Env-Or 'PICO_HOME' (Join-Path $HOME '.pico')
$BinDir     = Env-Or 'PICO_BIN_DIR' (Join-Path $Prefix 'bin')
$HermesRepo = Env-Or 'PICO_HERMES_REPO' 'NousResearch/hermes-agent'
$HermesRef  = Env-Or 'PICO_HERMES_REF' 'b222bced94bc1588423022ba59d7336d0e486c89'
$UvVersion  = Env-Or 'PICO_UV_VERSION' '0.13.5'
$BunVersion = Env-Or 'PICO_BUN_VERSION' '1.3.13'
$PyVersion  = '3.14'
if ($env:PICO_NO_WEB -eq '1') { $NoWeb = $true }
if ($env:PICO_NO_MODIFY_PATH -eq '1') { $NoModifyPath = $true }
if ($env:PICO_YES -eq '1') { $Yes = $true }

# ------------------------------------------------------------------ output
$esc = [char]27
$color = -not $env:NO_COLOR -and $Host.UI.SupportsVirtualTerminal
if ($color) { $PINK = "$esc[38;2;255;46;153m"; $DIM = "$esc[2m"; $RED = "$esc[31m"; $B = "$esc[1m"; $R = "$esc[0m" }
else { $PINK = ''; $DIM = ''; $RED = ''; $B = ''; $R = '' }
$Log = $null
function Ok([string]$s)   { Write-Host "  $PINK$([char]0x2713)$R $s" }
function Note([string]$s) { Write-Host "  $DIM$s$R" }
function Step([string]$s) { Write-Host "  $PINK$([char]0xB7)$R $DIM$s$R" }
function Die([string]$s) {
  Write-Host "  $RED$([char]0x2717)$R $s"
  if ($Log -and (Test-Path $Log)) { Get-Content $Log -Tail 12 | ForEach-Object { Write-Host "    $_" }; Write-Host "  ${DIM}full log: $Log$R" }
  throw "pico install failed: $s"
}
# Native tools write progress to stderr; under 'Stop' Windows PowerShell 5.1 turns that into a terminating
# error when redirected, so native calls run with 'Continue' and are judged by their exit code only.
function Quiet([scriptblock]$b) { $ErrorActionPreference = 'Continue'; & $b *>> $Log; return $LASTEXITCODE }
function Run([string]$exe, [string[]]$argv) {
  $rc = Quiet { & $exe @argv }
  if ($rc -ne 0) { Die "failed: $exe $($argv -join ' ')" }
}
function Have([string]$c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Fetch([string]$url, [string]$out) { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out }
function Short([string]$s) { if ($s.Length -gt 7) { $s.Substring(0, 7) } else { $s } }

Write-Host "$PINK /\_/\$R"
Write-Host "$PINK( o.o )$R  ${B}pico installer$R"
Write-Host "$PINK > ^ <$R"
Write-Host ''

# ------------------------------------------------------------------ detect
$arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'ARM64' { 'arm64' } 'AMD64' { 'x64' } default { Die "unsupported CPU $env:PROCESSOR_ARCHITECTURE" } }
if ($env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { $arch = 'arm64' }
$Prefix = [IO.Path]::GetFullPath($Prefix); $Data = [IO.Path]::GetFullPath($Data); $BinDir = [IO.Path]::GetFullPath($BinDir)
if ($SrcLocal) { $SrcLocal = [IO.Path]::GetFullPath($SrcLocal) }
if ($Prefix -eq $Data) { Die 'PICO_PREFIX and PICO_HOME must differ (app and data stay separate)' }
$action = if (Test-Path (Join-Path $Prefix 'install.json')) { 'update' } else { 'install' }
Ok "windows $arch"

if ($DryRun) {
  Write-Host ''
  Note "plan ($action, nothing will be changed):"
  Note "  app      $Prefix"
  Note "  data     $Data (kept as is)"
  Note "  source   $(if ($SrcLocal) { "local $SrcLocal" } else { "$Repo@$Ref" })"
  Note "  hermes   $HermesRepo@$($HermesRef.Substring(0, [Math]::Min(12, $HermesRef.Length)))"
  Note "  python   $PyVersion via uv $UvVersion (private copy)"
  Note "  cli      release asset pico-windows-x64.exe if PICO_REF is a release tag, else built with bun $BunVersion"
  Note "  web      $(if ($NoWeb) { 'skipped (-NoWeb)' } else { 'release asset or npm build if node is present, else skipped' })"
  Note "  path     $BinDir added to your user PATH (if missing)"
  return
}

if (-not $Yes -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
  $ans = Read-Host "  $action $Prefix? [Y/n]"
  if ($ans -match '^(n|no)$') { Note 'cancelled'; return }
}

$t0 = Get-Date
$Tmp = Join-Path $Prefix 'tmp'
New-Item -ItemType Directory -Force -Path (Join-Path $Prefix 'bin'), $Tmp, (Join-Path $Prefix 'tools') | Out-Null
$Log = Join-Path $Prefix 'install.log'
Set-Content -Path $Log -Value '' -Encoding UTF8

$venvPy = Join-Path $Prefix 'venv\Scripts\python.exe'
function Stop-Engine {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq $venvPy } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
Stop-Engine

# ------------------------------------------------------------------ uv
$Uv = Join-Path $Prefix 'tools\uv.exe'
if (-not (Test-Path $Uv)) {
  Step "getting uv $UvVersion"
  $uvArch = if ($arch -eq 'arm64') { 'aarch64' } else { 'x86_64' }
  $zip = Join-Path $Tmp 'uv.zip'
  try { Fetch "https://github.com/astral-sh/uv/releases/download/$UvVersion/uv-$uvArch-pc-windows-msvc.zip" $zip } catch { Die 'could not download uv' }
  Expand-Archive -Force -Path $zip -DestinationPath (Join-Path $Tmp 'uv')
  Copy-Item -Force (Get-ChildItem (Join-Path $Tmp 'uv') -Recurse -Filter uv.exe | Select-Object -First 1).FullName $Uv
  Remove-Item -Recurse -Force $zip, (Join-Path $Tmp 'uv')
}
Ok "uv $((& $Uv --version).Split(' ')[1])"

# ------------------------------------------------------------------ pico source
$Src = Join-Path $Prefix 'src'
function Replace-Dir([string]$from, [string]$to) { if (Test-Path $to) { Remove-Item -Recurse -Force $to }; Move-Item $from $to }
$slug = if ($Repo -match '^https://github\.com/([^/]+/[^/.]+?)(\.git)?/?$') { $Matches[1] } else { $null }
if ($SrcLocal) {
  if (-not ((Test-Path (Join-Path $SrcLocal 'engine')) -and (Test-Path (Join-Path $SrcLocal 'cli')))) { Die "PICO_SRC=$SrcLocal is not a pico checkout" }
  $source = 'local'
  $commit = if (Have git) { & { $ErrorActionPreference = 'Continue'; git -C $SrcLocal rev-parse HEAD 2>$null } } else { 'local' }
  if (-not $commit) { $commit = 'local' }
  $new = "$Src.new"; if (Test-Path $new) { Remove-Item -Recurse -Force $new }
  $rc = Quiet { robocopy $SrcLocal $new /E /NFL /NDL /NJH /NJS /NP /XD .git node_modules dist __pycache__ .venv ios desktop eval }
  if ($rc -ge 8) { Die "could not copy $SrcLocal" }
  $global:LASTEXITCODE = 0
  Replace-Dir $new $Src
} elseif (Have git) {
  $source = 'git'
  Step "fetching pico ($Ref)"
  if (-not (Test-Path (Join-Path $Src '.git'))) {
    if (Test-Path $Src) { Remove-Item -Recurse -Force $Src }
    Run git @('init', '-q', $Src); Run git @('-C', $Src, 'remote', 'add', 'origin', $Repo)
  }
  Run git @('-C', $Src, 'remote', 'set-url', 'origin', $Repo)
  Run git @('-C', $Src, 'fetch', '-q', '--depth', '1', 'origin', $Ref)
  Run git @('-C', $Src, 'reset', '-q', '--hard', 'FETCH_HEAD')
  Run git @('-C', $Src, 'clean', '-q', '-fdx')
  $commit = & { $ErrorActionPreference = 'Continue'; git -C $Src rev-parse HEAD 2>$null }
} else {
  $source = 'tarball'
  if (-not $slug) { Die 'no git and PICO_REPO is not a github.com URL' }
  Step "downloading pico ($Ref)"
  $zip = Join-Path $Tmp 'pico.zip'
  try { Fetch "https://codeload.github.com/$slug/zip/$Ref" $zip } catch { Die "could not download $Repo@$Ref" }
  $x = Join-Path $Tmp 'pico-x'; Expand-Archive -Force -Path $zip -DestinationPath $x
  Replace-Dir (Get-ChildItem $x -Directory | Select-Object -First 1).FullName $Src
  Remove-Item -Recurse -Force $zip, $x
  try { $commit = (Invoke-RestMethod -Headers @{ Accept = 'application/vnd.github.sha' } "https://api.github.com/repos/$slug/commits/$Ref") } catch { $commit = $Ref }
}
$version = (Get-Content (Join-Path $Src 'cli\package.json') -Raw | ConvertFrom-Json).version
Ok "pico $version $([char]0xB7) $(Short $commit) $([char]0xB7) $source"

# ------------------------------------------------------------------ hermes agent (pinned)
$Ha = Join-Path $Prefix 'hermes-agent'
$refFile = Join-Path $Ha '.pico-hermes-ref'
if (-not ((Test-Path $refFile) -and ((Get-Content $refFile -Raw).Trim() -eq $HermesRef))) {
  Step 'downloading hermes agent'
  $zip = Join-Path $Tmp 'hermes.zip'
  try { Fetch "https://codeload.github.com/$HermesRepo/zip/$HermesRef" $zip } catch { Die "could not download hermes agent $HermesRef" }
  $x = Join-Path $Tmp 'hermes-x'; Expand-Archive -Force -Path $zip -DestinationPath $x
  $root = (Get-ChildItem $x -Directory | Select-Object -First 1).FullName
  foreach ($d in 'tests', 'tests-js', 'website', 'apps', 'contributors', 'evals') { $p = Join-Path $root $d; if (Test-Path $p) { Remove-Item -Recurse -Force $p } }
  Set-Content -Path (Join-Path $root '.pico-hermes-ref') -Value $HermesRef -Encoding ASCII
  Replace-Dir $root $Ha
  Remove-Item -Recurse -Force $zip, $x
}
Ok "hermes agent $(Short $HermesRef)"

# ------------------------------------------------------------------ python + venv
$env:UV_PYTHON_INSTALL_DIR = Join-Path $Prefix 'python'
$env:UV_PYTHON_PREFERENCE = 'only-managed'
$env:UV_NO_PROGRESS = '1'
Step "python $PyVersion + packages"
Run $Uv @('python', 'install', $PyVersion)
$venv = Join-Path $Prefix 'venv'
if (Test-Path $venv) { Remove-Item -Recurse -Force $venv }
Run $Uv @('venv', '-q', $venv, '--python', $PyVersion)
$req = Join-Path $Tmp 'hermes-req.txt'
Run $Uv @('export', '-q', '--project', $Ha, '--frozen', '--no-dev', '--no-emit-project', '--no-hashes', '--no-header', '-o', $req)
Run $Uv @('pip', 'install', '-q', '--python', $venvPy, '--no-deps', '-r', $req)
Run $Uv @('pip', 'install', '-q', '--python', $venvPy, '-e', (Join-Path $Src 'engine'))
$env:PYTHONPATH = $Ha; $env:HERMES_HOME = Join-Path $Tmp 'hermes-check'; $env:HERMES_DISABLE_LAZY_INSTALLS = '1'
Push-Location $Tmp
try { $chk = Quiet { & $venvPy -c 'from run_agent import AIAgent; import pico.server' } } finally { Pop-Location }
Remove-Item Env:PYTHONPATH, Env:HERMES_HOME
if ($chk -ne 0) { Die 'engine check failed (import run_agent.AIAgent)' }
Ok "python $(& $venvPy -c 'import platform; print(platform.python_version())') $([char]0xB7) engine ready"

# ------------------------------------------------------------------ cli binary
$Cli = Join-Path $Prefix 'bin\pico-cli.exe'
$gotCli = $false
$cliUrl = $env:PICO_CLI_URL
if (-not $cliUrl -and -not $SrcLocal -and $Ref -match '^v\d') { $cliUrl = "$Repo/releases/download/$Ref/pico-windows-x64.exe" }  # x64 also runs on ARM64 (emulated)
if ($cliUrl) {
  try { Fetch $cliUrl "$Cli.new"; Move-Item -Force "$Cli.new" $Cli; $gotCli = $true; Ok 'terminal app (release)' }
  catch { Note "no release binary at $cliUrl $([char]0x2014) building instead" }
}
if (-not $gotCli) {
  $tempBun = $false
  if (Have bun) { $bun = (Get-Command bun).Source }
  else {
    # bun has no native Windows ARM64 build yet; the x64 one runs under emulation and builds an x64 exe.
    Step "getting bun $BunVersion (build tool, removed after)"
    $zip = Join-Path $Tmp 'bun.zip'
    try { Fetch "https://github.com/oven-sh/bun/releases/download/bun-v$BunVersion/bun-windows-x64-baseline.zip" $zip } catch { Die 'could not download bun' }
    Expand-Archive -Force -Path $zip -DestinationPath (Join-Path $Tmp 'bun')
    $bun = (Get-ChildItem (Join-Path $Tmp 'bun') -Recurse -Filter bun.exe | Select-Object -First 1).FullName
    $tempBun = $true
  }
  Step 'building terminal app'
  Push-Location (Join-Path $Src 'cli')
  try { $rc = Quiet { & $bun build src/main.ts --compile --minify --sourcemap=none --outfile "$Cli.new" } } finally { Pop-Location }
  if ($rc -ne 0 -or -not (Test-Path "$Cli.new")) { Die 'cli build failed' }
  Move-Item -Force "$Cli.new" $Cli
  if ($tempBun) { Remove-Item -Recurse -Force (Join-Path $Tmp 'bun'), (Join-Path $Tmp 'bun.zip') }
  Ok "terminal app (built with bun $BunVersion)"
}

# ------------------------------------------------------------------ web app (optional)
$Web = Join-Path $Src 'web\dist'
if ($NoWeb) { Note 'web app skipped (-NoWeb)' }
else {
  $webOk = $false
  if (-not $SrcLocal -and $Ref -match '^v\d') {
    try {
      $tgz = Join-Path $Tmp 'web.tar.gz'; Fetch "$Repo/releases/download/$Ref/pico-web.tar.gz" $tgz
      New-Item -ItemType Directory -Force -Path $Web | Out-Null
      if ((Quiet { tar -xzf $tgz -C $Web }) -eq 0) { $webOk = $true }
    } catch { Note 'no prebuilt web app for this release' }
  }
  if (-not $webOk -and (Have npm)) {
    Step 'building web app'
    Push-Location (Join-Path $Src 'web')
    try {
      if ((Quiet { npm ci --no-audit --no-fund --loglevel=error }) -eq 0 -and (Quiet { npm run build }) -eq 0) { $webOk = $true }
    } finally { Pop-Location }
    Remove-Item -Recurse -Force (Join-Path $Src 'web\node_modules') -ErrorAction SilentlyContinue
  }
  if ($webOk) { Ok 'web app' } else { Note "web app skipped (no release asset or node) $([char]0x2014) the terminal app works without it" }
}

# ------------------------------------------------------------------ launcher
$launcherPs1 = @"
# Pico launcher, written by the installer (re-run it, or ``pico update``, to refresh).
`$ErrorActionPreference = 'Stop'
`$env:PICO_PREFIX = '$($Prefix.Replace("'", "''"))'
if (-not `$env:PICO_HOME) { `$env:PICO_HOME = '$($Data.Replace("'", "''"))' }
`$env:PICO_HERMES_PATH = Join-Path `$env:PICO_PREFIX 'hermes-agent'
`$env:PICO_WEB_DIST = Join-Path `$env:PICO_PREFIX 'src\web\dist'
`$env:HERMES_DISABLE_LAZY_INSTALLS = '1'
`$py = Join-Path `$env:PICO_PREFIX 'venv\Scripts\python.exe'
`$cli = Join-Path `$env:PICO_PREFIX 'bin\pico-cli.exe'
`$skip = @('update', 'uninstall', '-v', '--version', '-h', '--help') -contains `$args[0]
if (-not `$skip -and -not `$env:PICO_URL) {
  `$port = if (`$env:PICO_PORT) { `$env:PICO_PORT } else { '7878' }
  `$url = "http://127.0.0.1:`$port/api/health"
  function Up { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 `$url | Out-Null; `$true } catch { `$false } }
  if (-not (Up)) {
    New-Item -ItemType Directory -Force -Path `$env:PICO_HOME | Out-Null
    `$log = Join-Path `$env:PICO_HOME 'engine.log'
    Start-Process -FilePath `$py -ArgumentList '-m', 'pico.server' -WorkingDirectory `$env:PICO_HOME -WindowStyle Hidden ``
      -RedirectStandardOutput `$log -RedirectStandardError (Join-Path `$env:PICO_HOME 'engine.err.log') | Out-Null
    for (`$i = 0; `$i -lt 120 -and -not (Up); `$i++) { Start-Sleep -Milliseconds 250 }
  }
}
& `$cli @args
exit `$LASTEXITCODE
"@
Set-Content -Path (Join-Path $Prefix 'bin\pico.ps1') -Value $launcherPs1 -Encoding UTF8
$launcherCmd = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0pico.ps1`" %*`r`nexit /b %ERRORLEVEL%`r`n"
Set-Content -Path (Join-Path $Prefix 'bin\pico.cmd') -Value $launcherCmd -Encoding ASCII -NoNewline
if ($BinDir -ne (Join-Path $Prefix 'bin')) {
  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  $shim = "@echo off`r`n`"$(Join-Path $Prefix 'bin\pico.cmd')`" %*`r`n"
  Set-Content -Path (Join-Path $BinDir 'pico.cmd') -Value $shim -Encoding ASCII -NoNewline
}

# ------------------------------------------------------------------ PATH (user scope)
$run = 'pico'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not $userPath) { $userPath = '' }
$onPath = ($userPath.Split(';') + $env:Path.Split(';')) | Where-Object { $_ -and ($_.TrimEnd('\') -ieq $BinDir.TrimEnd('\')) }
if ($onPath) { Ok "pico on PATH ($BinDir)" }
elseif ($NoModifyPath) { Note "$BinDir is not on PATH $([char]0x2014) run $(Join-Path $BinDir 'pico.cmd')"; $run = Join-Path $BinDir 'pico.cmd' }
else {
  $newPath = if ($userPath) { "$($userPath.TrimEnd(';'));$BinDir" } else { $BinDir }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  $env:Path = "$env:Path;$BinDir"
  Ok "added $BinDir to your user PATH (open a new terminal)"
}

# ------------------------------------------------------------------ record + doctor
$info = [ordered]@{
  version = $version; commit = "$commit"; source = $source; repo = $Repo; ref = $Ref; src_path = $SrcLocal
  hermes_repo = $HermesRepo; hermes_ref = $HermesRef; prefix = $Prefix; home = $Data; bin_dir = $BinDir
  linked = $true; modify_path = (-not $NoModifyPath); no_web = [bool]$NoWeb; web = (Test-Path (Join-Path $Web 'index.html'))
  os = 'windows'; arch = $arch; installed_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
}
$info | ConvertTo-Json | Set-Content -Path (Join-Path $Prefix 'install.json') -Encoding UTF8
Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue

$env:PICO_HOME = $Data
$launcher = Join-Path $Prefix 'bin\pico.cmd'
if ((Quiet { & $launcher doctor }) -ne 0) { & (Join-Path $Prefix 'bin\pico.cmd') doctor; Stop-Engine; Die "pico doctor failed $([char]0x2014) engine log: $Data\engine.log" }
Ok 'pico doctor'
Stop-Engine

$secs = [int]((Get-Date) - $t0).TotalSeconds
$size = '{0:N0}M' -f ((Get-ChildItem $Prefix -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB)
$done = if ($action -eq 'update') { 'updated' } else { 'installed' }
Write-Host ''
Write-Host "  $PINK$([char]0x2713) $done$R $DIM$([char]0xB7) ${secs}s $([char]0xB7) $size $([char]0xB7) run: $R$B$run$R"
