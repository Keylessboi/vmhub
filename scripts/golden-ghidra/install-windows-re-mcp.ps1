# install-windows-re-mcp.ps1 - expose the Windows RE tools as MCP servers (streamable-http, one port each).
#
# Runs elevated inside a STAGING clone, after install-windows.ps1 (Ghidra) and install-windows-re-tools.ps1.
# Idempotent. Pure ASCII (the guest-agent file transfer breaks on non-ASCII).
#
#   8081  ghidra        GhidraMCP bridge                 (install-windows.ps1)
#   8083  x64dbg        x64dbg-mcp (npm, Node.js)        task WinRE-X64dbg      AtLogOn, user vmhub, interactive
#   8085  wireshark     wireshark-mcp (own venv)         task WinRE-Wireshark   SYSTEM, AtStartup
#   8086  winre-toolbox mcp/winre-toolbox (own venv)     task WinRE-Toolbox     SYSTEM, AtStartup
#   8089  ghidra        GhidraMCP headless REST          (install-windows.ps1)
#
# MCP endpoint is http://<vm-ip>:<port>/mcp on every MCP port.
#
# Why x64dbg-mcp (npm, ouonet/x64dbg-mcp, MIT) and not rison1337/x64dbgmcp (GPL-3.0):
#   - it serves Streamable HTTP natively (`x64dbg-mcp --transport streamable-http --host H --port P`);
#     rison1337's documented setup is stdio only, which would need an extra proxy;
#   - MIT licence; the npm release 1.3.1 (2026-05-30) is published with npm provenance, ships a prebuilt
#     x64dbg plugin loader (no compiler needed) and talks to x64dbg through x64bridge.dll;
#   - it launches x32dbg/x64dbg itself on load_executable / attach_to_process, but x64dbg is a GUI
#     program, so the server must live in the interactive desktop session: an -AtLogOn task for the
#     autologon user (not SYSTEM / session 0, where the debugger would have no window station).
# Its HTTP server does not check the Host header or authenticate: lab network only. The 8083 handshake
# is a plain initialize/tools/list, it does not need a debugger to be running.
#
# Python MCP servers are kept in separate venvs because wireshark-mcp needs mcp>=2.1 while winre-toolbox
# (like re-toolbox) needs mcp>=1.28,<2.
param(
  [string]$ToolboxSrc = 'C:\Tools\mcp\winre-toolbox'   # folder holding pyproject.toml of winre-toolbox-mcp
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$NodeVer    = '24.21.0'
$NodeMsi    = "node-v$NodeVer-x64.msi"
$NodeUrl    = "https://nodejs.org/dist/v$NodeVer/$NodeMsi"
$NodeSha    = 'bb0eaee134f9357f22aea915ee793343e627aefc1e66488164bac6915bce2cac'   # nodejs.org SHASUMS256.txt
$X64MpcVer  = '1.3.1'                                                              # npm x64dbg-mcp
$WsMcpVer   = '3.0.0'                                                              # PyPI wireshark-mcp

$Tools      = 'C:\Tools'
$Cache      = "$Tools\_cache"
$McpDir     = "$Tools\winre-mcp"
$ToolboxVenv = "$Tools\winre-mcp-venv"
$WsVenv     = "$Tools\winre-wireshark-venv"
$X64Dir     = "$Tools\x64dbg"
$X64McpDir  = "$Tools\x64dbg-mcp"
$X64Prefix  = "$X64McpDir\npm"
$X64Config  = "$X64McpDir\config.env"
$NodeDir    = 'C:\Program Files\nodejs'
$WsDir      = 'C:\Program Files\Wireshark'
$PyHome     = 'C:\Program Files\Python312'
$Subnet     = '10.10.10.0/24'

function Log($m) { Write-Output "== $m" }
function Warn($m) { Write-Output "  WARN $m" }

function Fetch($url, $sha, $dest) {
  if ((Test-Path $dest) -and (Get-FileHash $dest -Algorithm SHA256).Hash -eq $sha.ToUpper()) { return }
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile "$dest.part"
  $got = (Get-FileHash "$dest.part" -Algorithm SHA256).Hash
  if ($got -ne $sha.ToUpper()) { Remove-Item -Force "$dest.part"; throw "sha256 mismatch for $url ($got)" }
  Move-Item -Force "$dest.part" $dest
}

if (-not (Test-Path "$ToolboxSrc\pyproject.toml")) { throw "winre-toolbox source not found at $ToolboxSrc (pass -ToolboxSrc)" }
if (-not (Test-Path "$WsDir\tshark.exe")) { throw 'tshark not installed: run install-windows-re-tools.ps1 first' }
if (-not (Test-Path "$X64Dir\release\x64\x64dbg.exe")) { throw 'x64dbg not installed: run install-windows-re-tools.ps1 first' }
New-Item -ItemType Directory -Force $Tools, $Cache, $McpDir, $X64McpDir | Out-Null

# ---- stop the previous run's servers (a running exe cannot be replaced by pip / npm) -----------------------
Log 'stop previous run'
foreach ($n in 'WinRE-Toolbox', 'WinRE-Wireshark', 'WinRE-X64dbg') {
  if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue }
}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like "$ToolboxVenv\*" -or $_.ExecutablePath -like "$WsVenv\*" -or
                                         $_.ExecutablePath -like "$NodeDir\*" -or $_.ExecutablePath -like "$X64Dir\*") } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 2

# ---- python ------------------------------------------------------------------------------------------------
$Python = @(
  $(if (Test-Path "$PyHome\python.exe") { "$PyHome\python.exe" })
  (Get-ChildItem 'C:\Users\*\AppData\Local\Programs\Python\Python3*\python.exe', 'C:\Program Files\Python3*\python.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | ForEach-Object FullName)
  (Get-Command python.exe -ErrorAction SilentlyContinue | Where-Object { $_.Source -notlike '*WindowsApps*' } | ForEach-Object Source)
) | Where-Object { $_ } | Select-Object -First 1
if (-not $Python) { throw 'no Python 3.10+ found' }
Log "python: $Python"
$PyDir = Split-Path $Python

# ---- venv 1: winre-toolbox (mcp<2) -------------------------------------------------------------------------
Log "venv $ToolboxVenv (winre-toolbox, mcp<2)"
if (-not (Test-Path "$ToolboxVenv\Scripts\python.exe")) { & $Python -m venv $ToolboxVenv; if ($LASTEXITCODE) { throw 'venv failed' } }
& "$ToolboxVenv\Scripts\python.exe" -m pip install -q --upgrade pip
& "$ToolboxVenv\Scripts\python.exe" -m pip install -q 'mcp>=1.28,<2' pefile
if ($LASTEXITCODE) { throw 'toolbox dependencies failed' }
& "$ToolboxVenv\Scripts\python.exe" -m pip install -q --force-reinstall --no-deps $ToolboxSrc
if ($LASTEXITCODE) { throw 'winre-toolbox install failed' }

# ---- venv 2: wireshark-mcp (mcp>=2.1) ----------------------------------------------------------------------
Log "venv $WsVenv (wireshark-mcp $WsMcpVer, mcp>=2.1)"
if (-not (Test-Path "$WsVenv\Scripts\python.exe")) { & $Python -m venv $WsVenv; if ($LASTEXITCODE) { throw 'venv failed' } }
& "$WsVenv\Scripts\python.exe" -m pip install -q --upgrade pip
& "$WsVenv\Scripts\python.exe" -m pip install -q "wireshark-mcp==$WsMcpVer"
if ($LASTEXITCODE) { throw 'wireshark-mcp install failed' }
if (-not (Test-Path "$WsVenv\Scripts\wireshark-mcp.exe")) { throw 'wireshark-mcp.exe missing after install' }

# ---- Node.js + x64dbg-mcp ----------------------------------------------------------------------------------
Log "node.js $NodeVer"
$NodeExe = "$NodeDir\node.exe"
$haveNode = $false
if (Test-Path $NodeExe) { $haveNode = ((& $NodeExe --version) -eq "v$NodeVer") }
if (-not $haveNode) {
  Fetch $NodeUrl $NodeSha "$Cache\$NodeMsi"
  $p = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @('/i', "`"$Cache\$NodeMsi`"", '/qn', '/norestart')
  if ($p.ExitCode -notin 0, 3010) { throw "Node.js install failed: $($p.ExitCode)" }
}
if (-not (Test-Path $NodeExe)) { throw "node.exe not found at $NodeExe" }
$env:Path = "$NodeDir;" + $env:Path

Log "x64dbg-mcp $X64MpcVer (npm, prefix $X64Prefix)"
# Pre-seed the config the server and its postinstall read (X64DBG_MCP_CONFIG wins over every other location).
# The postinstall adds BRIDGE_AUTH_TOKEN, deploys the prebuilt plugin loader + python bridge into
# <x64dbg>\release\x64\plugins and x32\plugins, and installs iced_x86 into PYTHON_HOME_X64.
if (-not (Test-Path $X64Config)) {
  @(
    "X64DBG_PATH=$X64Dir",
    "PYTHON_HOME_X64=$PyDir",
    'BRIDGE_HOST=127.0.0.1',
    'BRIDGE_PORT=27042',
    'MCP_TRANSPORT=streamable-http',
    'MCP_HTTP_HOST=0.0.0.0',
    'MCP_HTTP_PORT=8083',
    'MAX_SESSIONS=1',
    'LOG_LEVEL=info'
  ) | Set-Content -Encoding ascii $X64Config
}
$env:X64DBG_MCP_CONFIG = $X64Config
$env:X64DBG_PATH = $X64Dir
& "$NodeDir\npm.cmd" install -g "x64dbg-mcp@$X64MpcVer" --prefix $X64Prefix --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE) { throw 'npm install x64dbg-mcp failed' }
$X64Server = "$X64Prefix\node_modules\x64dbg-mcp\dist\server.js"
if (-not (Test-Path $X64Server)) { throw "x64dbg-mcp server.js not found at $X64Server" }
if (-not (Test-Path "$X64Dir\release\x64\plugins\x64dbg_mcp_loader.dp64")) {
  # postinstall did not deploy (npm skipped scripts?): run it by hand with the same environment.
  $env:npm_config_global = 'true'
  & $NodeExe "$X64Prefix\node_modules\x64dbg-mcp\scripts\postinstall.mjs"
  if ($LASTEXITCODE -or -not (Test-Path "$X64Dir\release\x64\plugins\x64dbg_mcp_loader.dp64")) { throw 'x64dbg-mcp plugin loader was not deployed' }
}
Write-Output "  x64dbg plugins: $((Get-ChildItem "$X64Dir\release\x64\plugins" -Name | Where-Object { $_ -like 'x64dbg_*' }) -join ', ')"

# ---- launchers ------------------------------------------------------------------------------------------------
# Placeholders are replaced here so the scripts contain no install-time interpolation. The launchers keep
# $ErrorActionPreference at Continue: with `Stop`, the first line a server writes to stderr (uvicorn logs
# there) would be raised as a terminating error by Windows PowerShell 5.1 and kill the server.
Log 'launchers'
$Common = @'
$ErrorActionPreference = 'Continue'
$log = '@LOG@'
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) { Remove-Item -Force $log -ErrorAction SilentlyContinue }
$env:Path = 'C:\Tools\sysinternals;C:\Tools\die;C:\Tools\capa;C:\Tools\floss;C:\Tools\dotnet-tools;C:\Program Files\dotnet;C:\Program Files\Wireshark;C:\Program Files\nodejs;' + $env:Path
$env:DOTNET_ROOT = 'C:\Program Files\dotnet'
$env:DOTNET_CLI_HOME = 'C:\Tools\_dotnet-home'
$env:DOTNET_NOLOGO = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUNBUFFERED = '1'
'@

$Toolbox = $Common + @'
# Nothing to wait for but the venv itself (pip may still be finishing on a fresh boot after the install).
for ($i = 0; $i -lt 90 -and -not (Test-Path '@VENV@\Scripts\python.exe'); $i++) { Start-Sleep 2 }
& '@VENV@\Scripts\python.exe' -m winre_toolbox_mcp --host 0.0.0.0 --port 8086 *>> $log
exit $LASTEXITCODE
'@

$Wireshark = $Common + @'
# wireshark-mcp shells out to tshark; wait until the Wireshark install is on disk.
for ($i = 0; $i -lt 90 -and -not (Test-Path '@WS@\tshark.exe'); $i++) { Start-Sleep 2 }
$env:WIRESHARK_MCP_TSHARK_PATH = '@WS@\tshark.exe'
$env:WIRESHARK_MCP_CAPINFOS_PATH = '@WS@\capinfos.exe'
$env:WIRESHARK_MCP_MERGECAP_PATH = '@WS@\mergecap.exe'
$env:WIRESHARK_MCP_EDITCAP_PATH = '@WS@\editcap.exe'
$env:WIRESHARK_MCP_DUMPCAP_PATH = '@WS@\dumpcap.exe'
$env:WIRESHARK_MCP_TEXT2PCAP_PATH = '@WS@\text2pcap.exe'
$env:WIRESHARK_MCP_ALLOWED_DIRS = 'C:\Users\vmhub,C:\Users\Public,C:\Tools\re-samples,C:\Windows\Temp'
& '@WSVENV@\Scripts\wireshark-mcp.exe' serve --transport streamable-http --host 0.0.0.0 --port 8085 --allow-insecure-http *>> $log
exit $LASTEXITCODE
'@

$X64 = $Common + @'
# This one runs in the interactive desktop session: it starts x64dbg windows on demand. Wait for the shell
# (AtLogOn fires before explorer is up) and for the plugin loader the npm postinstall deploys.
for ($i = 0; $i -lt 90 -and -not (Get-Process explorer -ErrorAction SilentlyContinue); $i++) { Start-Sleep 2 }
for ($i = 0; $i -lt 30 -and -not (Test-Path '@X64@\release\x64\plugins\x64dbg_mcp_loader.dp64'); $i++) { Start-Sleep 2 }
$env:X64DBG_MCP_CONFIG = '@CFG@'
$env:X64DBG_PATH = '@X64@'
& '@NODE@' '@SERVER@' --transport streamable-http --host 0.0.0.0 --port 8083 *>> $log
exit $LASTEXITCODE
'@

function Write-Launcher($file, $text, $logName) {
  $text = $text.Replace('@LOG@', "$McpDir\$logName").Replace('@VENV@', $ToolboxVenv).Replace('@WSVENV@', $WsVenv).Replace('@WS@', $WsDir).
    Replace('@X64@', $X64Dir).Replace('@CFG@', $X64Config).Replace('@NODE@', $NodeExe).Replace('@SERVER@', $X64Server)
  Set-Content -Encoding ascii "$McpDir\$file" $text
}
Write-Launcher 'toolbox.ps1' $Toolbox 'toolbox.log'
Write-Launcher 'wireshark.ps1' $Wireshark 'wireshark.log'
Write-Launcher 'x64dbg.ps1' $X64 'x64dbg.log'

# ---- firewall (guest subnet only) ---------------------------------------------------------------------------------
Log 'firewall'
Get-NetFirewallRule -DisplayName 'WinRE MCP' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'WinRE MCP' -Direction Inbound -Protocol TCP -LocalPort 8083, 8085, 8086 `
  -RemoteAddress $Subnet -Action Allow -Profile Any | Out-Null

# ---- scheduled tasks ---------------------------------------------------------------------------------------------------
Log 'scheduled tasks'
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$sysPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
function Register-Re($name, $script, $trigger, $principal) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
}
Register-Re 'WinRE-Toolbox'   "$McpDir\toolbox.ps1"   (New-ScheduledTaskTrigger -AtStartup) $sysPrincipal
Register-Re 'WinRE-Wireshark' "$McpDir\wireshark.ps1" (New-ScheduledTaskTrigger -AtStartup) $sysPrincipal

$DesktopUser = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon').DefaultUserName
if (-not $DesktopUser) { $DesktopUser = 'vmhub' }
$who = "$env:COMPUTERNAME\$DesktopUser"
$userPrincipal = New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Highest
Register-Re 'WinRE-X64dbg' "$McpDir\x64dbg.ps1" (New-ScheduledTaskTrigger -AtLogOn -User $who) $userPrincipal
foreach ($n in 'WinRE-Toolbox', 'WinRE-Wireshark', 'WinRE-X64dbg') { Start-ScheduledTask -TaskName $n }

# ---- verify: real MCP handshakes ------------------------------------------------------------------------------------
Log 'verify'
$check = @'
import json, sys, time, urllib.request
name, port, need = sys.argv[1], sys.argv[2], int(sys.argv[3])
URL = "http://127.0.0.1:%s/mcp" % port
H = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
def call(body, sid=None, method="POST"):
    h = dict(H, **({"mcp-session-id": sid} if sid else {}))
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.urlopen(urllib.request.Request(URL, data, h, method=method), timeout=60)
    text = r.read().decode()
    lines = [l[5:] for l in text.splitlines() if l.startswith("data:")] or [text]
    return r.headers.get("mcp-session-id"), (json.loads(lines[-1]) if lines[-1].strip() else None)
err = None
for _ in range(90):
    try:
        sid, init = call({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "golden-check", "version": "1"}}})
        call({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
        _, tools = call({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, sid)
        n = len(tools["result"]["tools"])
        try:
            call(None, sid, "DELETE")   # x64dbg-mcp allows one session at a time: do not leave ours open
        except Exception:
            pass
        print("  %s :%s %s tools=%d" % ("ok  " if n >= need else "FAIL", port, name, n))
        sys.exit(0 if n >= need else 1)
    except SystemExit:
        raise
    except Exception as e:
        err = e
        time.sleep(2)
print("  FAIL :%s %s no handshake: %s" % (port, name, err))
sys.exit(1)
'@
Set-Content -Encoding ascii "$McpDir\mcp-check.py" $check
$bad = New-Object System.Collections.Generic.List[string]
function Probe($name, $port, $need, $log) {
  & "$ToolboxVenv\Scripts\python.exe" "$McpDir\mcp-check.py" $name $port $need
  if ($LASTEXITCODE) {
    $bad.Add("${name}:${port}")
    if ($log -and (Test-Path "$McpDir\$log")) { Write-Output "---- $log (tail)"; Get-Content "$McpDir\$log" -Tail 25 }
  }
}
Probe 'x64dbg-mcp' 8083 1 'x64dbg.log'

# x64dbg warm-up. The first load_executable after install takes ~13 s and tripped the server's 2 s bridge
# health probe once ("Bridge disconnecting", 2026-10-12); later loads are fine. Do one real load now so the
# golden's first agent call does not hit it. Failure here is only a warning.
$warm = @'
import json, os, sys, time, urllib.request
URL = "http://127.0.0.1:8083/mcp"
H = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
def call(body, sid=None, method="POST"):
    h = dict(H, **({"mcp-session-id": sid} if sid else {}))
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.urlopen(urllib.request.Request(URL, data, h, method=method), timeout=120)
    text = r.read().decode()
    lines = [l[5:] for l in text.splitlines() if l.startswith("data:")] or [text]
    return r.headers.get("mcp-session-id"), (json.loads(lines[-1]) if lines[-1].strip() else None)
def tool(sid, name, args, n):
    _, r = call({"jsonrpc": "2.0", "id": n, "method": "tools/call", "params": {"name": name, "arguments": args}}, sid)
    res = r["result"]
    txt = "".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
    return res.get("isError"), txt
sid, _ = call({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "golden-warm", "version": "1"}}})
call({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
ok = False
for attempt in range(3):
    err, txt = tool(sid, "load_executable", {"executablePath": r"C:\Windows\System32\notepad.exe", "breakOnEntry": True}, 10 + attempt)
    if not err:
        ok = True
        tool(sid, "terminate_session", {"sessionId": json.loads(txt)["sessionId"]}, 20 + attempt)
        break
    print("  warm-up attempt %d failed: %s" % (attempt + 1, txt[:120]))
    time.sleep(5)
try:
    call(None, sid, "DELETE")
except Exception:
    pass
print("  %s x64dbg warm-up load" % ("ok  " if ok else "WARN"))
'@
Set-Content -Encoding ascii "$McpDir\x64dbg-warm.py" $warm
try { & "$ToolboxVenv\Scripts\python.exe" "$McpDir\x64dbg-warm.py" } catch { Warn "x64dbg warm-up failed: $($_.Exception.Message)" }
Get-Process x64dbg, x32dbg -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Probe 'wireshark-mcp' 8085 1 'wireshark.log'
Probe 'winre-toolbox' 8086 15 'toolbox.log'

# The Ghidra servers must still be answering (they were installed by install-windows.ps1).
if (Get-ScheduledTask -TaskName 'GhidraMCP-Bridge' -ErrorAction SilentlyContinue) {
  $ok = $false
  foreach ($i in 1..30) { try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:8089/check_connection; $ok = $true; break } catch { Start-Sleep 2 } }
  if ($ok) { Write-Output "  ok   :8089 ghidra headless ($($r.Content))" } else { Write-Output '  FAIL :8089 ghidra headless'; $bad.Add('ghidra:8089') }
  Probe 'ghidra' 8081 100 $null
} else {
  Warn 'GhidraMCP-Bridge task not found; skipping the 8081/8089 check (run install-windows.ps1)'
}

Remove-Item -Recurse -Force $Cache -ErrorAction SilentlyContinue
if ($bad.Count) { throw "MCP servers not answering: $($bad -join ', ')" }
Log 'done'
