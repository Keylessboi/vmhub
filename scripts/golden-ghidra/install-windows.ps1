# install-windows.ps1 - bake Ghidra + GhidraMCP into the Windows golden.
#
# Runs elevated inside a STAGING clone of windows-11-24h2 (never the template
# itself - see docs/golden-builds.md). Idempotent.
#
# What a clone gets:
#   C:\Tools\ghidra                    Ghidra 12.1.2 (+ GhidraMCP GUI extension), JDK = Temurin 21
#   task GhidraMCP-Headless            GhidraMCP headless REST server, 127.0.0.1:8089 (SYSTEM, at startup)
#   task GhidraMCP-Bridge              MCP bridge, streamable-http on 0.0.0.0:8081/mcp (SYSTEM, at startup)
#   C:\Tools\ghidra-mcp-bridge\Scripts\bridge-mcp-ghidra.exe   the same bridge for stdio use
#
# Both servers run in session 0 so no console window ever lands on the
# desktop that CursorTouch screenshots and drives.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is ~50x slower with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$GhidraVersion = '12.1.2'
$GhidraZip     = "ghidra_${GhidraVersion}_PUBLIC_20260605.zip"
$GhidraUrl     = "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GhidraVersion}_build/$GhidraZip"
$GhidraSha256  = 'b62e81a0390618466c019c60d8c2f796ced2509c4c1aea4a37644a77272cf99d'

$McpVersion    = '6.0.0'
$McpBase       = "https://github.com/bethington/ghidra-mcp/releases/download/v$McpVersion"
$McpZip        = "GhidraMCP-$McpVersion.zip"
$McpZipSha256  = '867731de27d5143632a010943b907a6485dd54d0e19729e2f85ee9f692c99873'
$McpWhl        = "ghidra_mcp_bridge-$McpVersion-py3-none-any.whl"
$McpWhlSha256  = '71939a890009826664720166d8f786f3a2ea2460f7effcd83c73759ba4241334'

$JdkUrl        = 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.msi'
$JdkSha256     = '454cfd334b9ca91c96dd8c2de97fcef6b9f1f98be9172ff076711f1c6b44e4e0'

$Tools     = 'C:\Tools'
$GhidraDir = "$Tools\ghidra_${GhidraVersion}_PUBLIC"
$BridgeDir = "$Tools\ghidra-mcp-bridge"
$McpDir    = "$Tools\ghidra-mcp"
$Cache     = "$Tools\_cache"

function Log($m) { Write-Output "== $m" }

function Fetch($url, $sha, $dest) {
  if ((Test-Path $dest) -and (Get-FileHash $dest -Algorithm SHA256).Hash -eq $sha.ToUpper()) { return }
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile "$dest.part"
  $got = (Get-FileHash "$dest.part" -Algorithm SHA256).Hash
  if ($got -ne $sha.ToUpper()) { throw "sha256 mismatch for $url ($got)" }
  Move-Item -Force "$dest.part" $dest
}

New-Item -ItemType Directory -Force $Tools, $Cache, $McpDir | Out-Null

Log 'download'
Fetch $GhidraUrl $GhidraSha256 "$Cache\$GhidraZip"
Fetch "$McpBase/$McpZip" $McpZipSha256 "$Cache\$McpZip"
Fetch "$McpBase/$McpWhl" $McpWhlSha256 "$Cache\$McpWhl"
Fetch $JdkUrl $JdkSha256 "$Cache\temurin21.msi"

Log 'jdk 21'
$p = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @('/i', "`"$Cache\temurin21.msi`"", '/qn', '/norestart',
  'ADDLOCAL=FeatureMain,FeatureEnvironment,FeatureJarFileRunWith,FeatureJavaHome')
if ($p.ExitCode -notin 0, 3010) { throw "JDK install failed: $($p.ExitCode)" }
$JavaHome = [Environment]::GetEnvironmentVariable('JAVA_HOME', 'Machine')
$Java = (Join-Path $JavaHome.TrimEnd("\") "bin\java.exe")
if (-not (Test-Path $Java)) { throw "java.exe not found under JAVA_HOME=$JavaHome" }

Log "ghidra $GhidraVersion -> $GhidraDir"
# bsdtar unpacks the 30k-file zip in seconds; Expand-Archive takes minutes.
if (-not (Test-Path "$GhidraDir\ghidraRun.bat")) { tar.exe -xf "$Cache\$GhidraZip" -C $Tools; if ($LASTEXITCODE) { throw 'ghidra unzip failed' } }
if (Test-Path "$Tools\ghidra") { cmd /c rmdir "$Tools\ghidra" | Out-Null }
cmd /c mklink /J "$Tools\ghidra" $GhidraDir | Out-Null
# Installation-level extension: loads for every user, no Install Extensions dance.
Remove-Item -Recurse -Force "$GhidraDir\Ghidra\Extensions\GhidraMCP" -ErrorAction SilentlyContinue
tar.exe -xf "$Cache\$McpZip" -C "$GhidraDir\Ghidra\Extensions"; if ($LASTEXITCODE) { throw 'GhidraMCP unzip failed' }

# Desktop shortcut + accepted user agreement for the autologon user.
$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut('C:\Users\Public\Desktop\Ghidra.lnk')
$lnk.TargetPath = "$Tools\ghidra\ghidraRun.bat"; $lnk.WorkingDirectory = "$Tools\ghidra"
$lnk.IconLocation = "$Tools\ghidra\support\ghidra.ico"; $lnk.WindowStyle = 7; $lnk.Save()
$DesktopUser = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon').DefaultUserName
if ($DesktopUser) {
  $prefs = "C:\Users\$DesktopUser\AppData\Roaming\ghidra\ghidra_${GhidraVersion}_PUBLIC"
  New-Item -ItemType Directory -Force $prefs | Out-Null
  # Select-String on a file that does not exist yet is a terminating error under $ErrorActionPreference='Stop'.
  if (-not ((Test-Path "$prefs\preferences") -and (Select-String -Quiet -Path "$prefs\preferences" -Pattern '^USER_AGREEMENT=ACCEPT'))) {
    Add-Content -Path "$prefs\preferences" -Value 'USER_AGREEMENT=ACCEPT' -Encoding ascii
  }
}

# A rerun finds the previous run's servers still up, and pip cannot replace a running bridge-mcp-ghidra.exe.
foreach ($n in 'GhidraMCP-Headless', 'GhidraMCP-Bridge') { Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue }
Get-Process bridge-mcp-ghidra, java -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 2

Log "bridge $McpVersion -> $BridgeDir"
# CursorTouch's golden already has Python 3.13 (per-user winget install).
$Python = @(
  (Get-Command python.exe -ErrorAction SilentlyContinue | Where-Object { $_.Source -notlike '*WindowsApps*' } | ForEach-Object Source)
  (Get-ChildItem 'C:\Users\*\AppData\Local\Programs\Python\Python3*\python.exe', 'C:\Program Files\Python3*\python.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | ForEach-Object FullName)
) | Where-Object { $_ } | Select-Object -First 1
if (-not $Python) { throw 'no Python 3.10+ found' }
Log "python: $Python"
if (-not (Test-Path "$BridgeDir\Scripts\python.exe")) { & $Python -m venv $BridgeDir; if ($LASTEXITCODE) { throw 'venv failed' } }
& "$BridgeDir\Scripts\python.exe" -m pip install -q --upgrade pip
& "$BridgeDir\Scripts\python.exe" -m pip install -q --force-reinstall "$Cache\$McpWhl"
if ($LASTEXITCODE) { throw 'bridge install failed' }

Log 'launchers'
# The headless server ships inside the plugin jar and runs on Ghidra's own
# jars, as upstream's docker/entrypoint.sh does.
@"
`$ErrorActionPreference = 'Stop'
`$g = '$Tools\ghidra'
`$cp = @((Get-ChildItem "`$g\Ghidra\Extensions\GhidraMCP\lib\GhidraMCP-*.jar")[0].FullName)
`$cp += Get-ChildItem "`$g\Ghidra\Framework\*\lib\*.jar", "`$g\Ghidra\Features\*\lib\*.jar", "`$g\Ghidra\Processors\*\lib\*.jar" | ForEach-Object FullName
`$env:GHIDRA_MCP_ALLOW_SCRIPTS = '1'   # lab VM: agents already have admin via vm_exec
New-Item -ItemType Directory -Force '$McpDir\projects' | Out-Null
Set-Location '$McpDir\projects'
& '$Java' -Xmx3g -XX:+UseG1GC "-Dghidra.home=`$g" "-Dapplication.name=GhidraMCP" -classpath (`$cp -join ';') com.xebyte.headless.GhidraMCPHeadlessServer --bind 127.0.0.1 --port 8089 *>> '$McpDir\headless.log'
"@ | Set-Content -Encoding ascii "$McpDir\headless.ps1"
# Host-header allowlist = the whole guest subnet: lite readdresses a clone
# after boot, after the bridge has already computed its own addresses.
@"
# The bridge only discovers the Ghidra server at startup; started before the server listens it
# registers 8 meta-tools instead of ~220. Both tasks start at boot, so wait for the server first.
for (`$i = 0; `$i -lt 90; `$i++) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:8089/check_connection | Out-Null; break } catch { Start-Sleep 2 } }
`$env:GHIDRA_MCP_URL = 'http://127.0.0.1:8089'
`$env:GHIDRA_MCP_ALLOWED_HOSTS = ((1..254 | ForEach-Object { "10.10.10.`$_" }) -join ',')
`$env:PYTHONIOENCODING = 'utf-8'
& '$BridgeDir\Scripts\bridge-mcp-ghidra.exe' --transport streamable-http --mcp-host 0.0.0.0 --mcp-port 8081 *>> '$McpDir\bridge.log'
"@ | Set-Content -Encoding ascii "$McpDir\bridge.ps1"

Log 'scheduled tasks'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
foreach ($t in @(@{ Name = 'GhidraMCP-Headless'; Script = "$McpDir\headless.ps1" }, @{ Name = 'GhidraMCP-Bridge'; Script = "$McpDir\bridge.ps1" })) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$($t.Script)`""
  Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) `
    -Principal $principal -Settings $settings -Force | Out-Null
  Stop-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName $t.Name
}

Log 'verify'
$ok = $false
foreach ($i in 1..90) { try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:8089/check_connection; $ok = $true; break } catch { Start-Sleep 2 } }
if (-not $ok) { Get-Content "$McpDir\headless.log" -Tail 30 -ErrorAction SilentlyContinue; throw 'headless server did not come up' }
Write-Output "headless: $($r.Content)"
$check = @'
import json, time, urllib.request
URL = "http://127.0.0.1:8081/mcp"
H = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
def call(body, sid=None):
    h = dict(H, **({"mcp-session-id": sid} if sid else {}))
    r = urllib.request.urlopen(urllib.request.Request(URL, json.dumps(body).encode(), h), timeout=60)
    text = r.read().decode()
    data = [l[5:] for l in text.splitlines() if l.startswith("data:")] or [text]
    return r.headers.get("mcp-session-id"), (json.loads(data[-1]) if data[-1].strip() else None)
for _ in range(60):
    try:
        sid, init = call({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "golden-check", "version": "1"}}})
        break
    except OSError:
        time.sleep(2)
call({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
_, tools = call({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, sid)
n = len(tools["result"]["tools"])
print("bridge:", init["result"]["serverInfo"], "tools:", n)
# 8 means the bridge started before the Ghidra server was up and registered only its meta-tools.
raise SystemExit(0 if n >= 100 else "bridge exposes only %d tools" % n)
'@
$check | & "$BridgeDir\Scripts\python.exe" -
if ($LASTEXITCODE) { Get-Content "$McpDir\bridge.log" -Tail 30 -ErrorAction SilentlyContinue; throw 'bridge check failed' }
Remove-Item -Recurse -Force $Cache
Log 'done'
