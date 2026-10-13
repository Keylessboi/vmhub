# install-windows-re-tools.ps1 - Windows reverse-engineering tool layer for the golden.
#
# Runs elevated inside a STAGING clone of the Windows golden, after install-windows.ps1
# (Ghidra + GhidraMCP). Never against the template itself - see docs/golden-builds.md. Idempotent.
# Pure ASCII on purpose: the guest-agent file transfer breaks on non-ASCII characters.
#
# What a clone gets (all under C:\Tools unless noted; CLI dirs are on the machine PATH):
#   sysinternals\        Sysinternals Suite (Authenticode-verified, EULAs pre-accepted)
#   x64dbg\              x64dbg snapshot (release\x64\x64dbg.exe, release\x96dbg.exe launcher)
#   pe-bear\ die\ ilspy\ dnspy\   GUI tools; die\ also holds the CLI diec.exe
#   capa\ floss\         Mandiant standalone binaries
#   dotnet-tools\        ilspycmd (dotnet global tool installed with --tool-path)
#   "C:\Program Files\dotnet"     .NET SDK 10 (ilspycmd 11.x targets net10.0; SDK 8/9 cannot run it)
#   "C:\Program Files\Wireshark"  Wireshark + tshark (analysis only, see the Npcap note below)
#   re-samples\          drop folder for samples, writable by Users
#   C:\Users\Public\Desktop\*.lnk  shortcuts for the GUI tools
#
# Integrity: every GitHub / Wireshark / dotnet download is pinned to a sha256 (sha512 for the dotnet
# SDK, which is what Microsoft publishes). Values for GitHub assets come from the release `digest`
# field (gh api repos/<owner>/<repo>/releases/latest); FLOSS publishes none, so its hash was computed
# from the v3.1.1 asset when this script was written. The Sysinternals Suite zip is updated in place
# at a fixed URL and has no published checksum, so instead every Sysinternals exe we use is checked
# with Get-AuthenticodeSignature (Status Valid, signer O=Microsoft Corporation) and removed if not.
#
# Wireshark / Npcap: the Wireshark installer's /S silent mode installs Wireshark WITHOUT Npcap
# (Wireshark User's Guide, "Windows installer command line options": "The silent installer will not
# install Npcap"), and the free Npcap installer cannot run silently either (Npcap guide: /S is "Npcap
# OEM only"; OEM is a paid licence). So the guest has no capture driver: live packet capture is done
# on the Proxmox host by vm_capture. Wireshark/tshark here are for ANALYSING pcaps.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is ~50x slower with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---- pins ------------------------------------------------------------------------------------------
$SysintUrl   = 'https://download.sysinternals.com/files/SysinternalsSuite.zip'   # signature-verified, no hash exists
$VcRedistUrl = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'                   # signature-verified (Microsoft)

$X64dbgTag   = '2026.05.27'
$X64dbgZip   = 'snapshot_2026-05-27_12-11.zip'
$X64dbgUrl   = "https://github.com/x64dbg/x64dbg/releases/download/$X64dbgTag/$X64dbgZip"
$X64dbgSha   = 'd41966dfc5b435a372798245300ca0ab7bb8e48bdbf48512c6fb20fcca427697'

$PeBearTag   = 'v0.7.2'
$PeBearZip   = 'PE-bear_0.7.2_qt6_x64_win_vs22.zip'
$PeBearUrl   = "https://github.com/hasherezade/pe-bear/releases/download/$PeBearTag/$PeBearZip"
$PeBearSha   = 'd2b995b213d0e6b3910a863c12fdb842722ce47387e65fc8e711ee9013d0876e'

$DieTag      = '3.21'
$DieZip      = 'die_win64_portable_3.21_x64.zip'
$DieUrl      = "https://github.com/horsicq/DIE-engine/releases/download/$DieTag/$DieZip"
$DieSha      = '078f2934f267392247f9c7b759a1c2457a48bc2000b25b80c2f129955ee4a3b9'

$IlspyTag    = 'v11.1'
$IlspyZip    = 'ILSpy_windows_selfcontained_11.1.0.9782-x64.zip'   # self-contained: no runtime needed for the GUI
$IlspyUrl    = "https://github.com/icsharpcode/ILSpy/releases/download/$IlspyTag/$IlspyZip"
$IlspySha    = 'd339789c62bbe23b157e528b89131bfc5b2ebbbd5303fa9357b1eb9d4db49313'
$IlspyCmdVer = '11.1.0.9782'                                         # NuGet ilspycmd, same ILSpy build

$DnspyTag    = 'v6.6.0'
$DnspyZip    = 'dnSpy-net-win64.zip'
$DnspyUrl    = "https://github.com/dnSpyEx/dnSpy/releases/download/$DnspyTag/$DnspyZip"
$DnspySha    = '8ed48f165dc355e869f3a0037ad4f9216147f995a5ae0258b296eeef1f73aab0'

$CapaTag     = 'v9.4.0'
$CapaZip     = 'capa-v9.4.0-windows.zip'
$CapaUrl     = "https://github.com/mandiant/capa/releases/download/$CapaTag/$CapaZip"
$CapaSha     = '670ab1a58b81f59cb57533bf4021ac1e7033fbe9b5d5cc180f796976081e3bb5'

$FlossTag    = 'v3.1.1'
$FlossZip    = 'floss-v3.1.1-windows.zip'
$FlossUrl    = "https://github.com/mandiant/flare-floss/releases/download/$FlossTag/$FlossZip"
$FlossSha    = '6c71089b8c629c69424b042769f1565f71adc6cd24b2f8d3713c96fa7fdac2fb'

$DotnetVer   = '10.0.401'
$DotnetUrl   = "https://builds.dotnet.microsoft.com/dotnet/Sdk/$DotnetVer/dotnet-sdk-$DotnetVer-win-x64.exe"
$DotnetSha512 = 'f0d8f8e7ec24efb05172a65dd80c4a9b1ef17efcebdbf0f57c15f436eea417960a7eeb6726c473a042373d6a8b94ac1adc7d680decbf7d2c45fa5c5662d62265'

$WsVer       = '4.6.9'
$WsExe       = "Wireshark-$WsVer-x64.exe"
$WsUrls      = @("https://www.wireshark.org/download/win64/$WsExe", "https://www.wireshark.org/download/win64/all-versions/$WsExe")
$WsSha       = 'bf9b5ce8a89f244c376a9b1a946276eaa06463dde3e33069a34d7f102f5878cf'

# ---- layout ----------------------------------------------------------------------------------------
$Tools    = 'C:\Tools'
$Cache    = "$Tools\_cache"
$SysDir   = "$Tools\sysinternals"
$X64Dir   = "$Tools\x64dbg"
$PeBearDir = "$Tools\pe-bear"
$DieDir   = "$Tools\die"
$IlspyDir = "$Tools\ilspy"
$DnspyDir = "$Tools\dnspy"
$CapaDir  = "$Tools\capa"
$FlossDir = "$Tools\floss"
$DnToolDir = "$Tools\dotnet-tools"
$Samples  = "$Tools\re-samples"
$WsDir    = 'C:\Program Files\Wireshark'
$Desktop  = 'C:\Users\Public\Desktop'
$Dotnet   = 'C:\Program Files\dotnet\dotnet.exe'
$UsersSid = '*S-1-5-32-545'   # BUILTIN\Users, locale independent

$Missing = New-Object System.Collections.Generic.List[string]

function Log($m) { Write-Output "== $m" }
function Warn($m) { Write-Output "  WARN $m" }

function Fetch($urls, $hash, $dest) {
  # $hash: 64 hex = sha256, 128 hex = sha512, empty = no hash (caller must verify another way).
  $algo = if ($hash -and $hash.Length -eq 128) { 'SHA512' } else { 'SHA256' }
  if ($hash -and (Test-Path $dest) -and (Get-FileHash $dest -Algorithm $algo).Hash -eq $hash.ToUpper()) { return }
  $lastErr = $null
  foreach ($url in @($urls)) {
    foreach ($try in 1..3) {
      try {
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile "$dest.part"
        if ($hash) {
          $got = (Get-FileHash "$dest.part" -Algorithm $algo).Hash
          if ($got -ne $hash.ToUpper()) { Remove-Item -Force "$dest.part"; throw "$algo mismatch for $url ($got)" }
        }
        Move-Item -Force "$dest.part" $dest
        return
      } catch {
        $lastErr = $_
        if ("$($_.Exception.Message)" -like '*mismatch*') { throw }   # a wrong hash is never retried
        Start-Sleep 3
      }
    }
  }
  throw "download failed for $(@($urls)[0]): $lastErr"
}

function Unpack($zip, $dest, $tag, $markerDir = $dest) {
  # bsdtar unpacks big zips in seconds; Expand-Archive takes minutes (Defender).
  # A marker file keeps reruns from re-extracting an unchanged pin.
  $marker = "$markerDir\.pin-$tag"
  if (Test-Path $marker) { return }
  New-Item -ItemType Directory -Force $dest | Out-Null
  tar.exe -xf $zip -C $dest
  if ($LASTEXITCODE) { throw "unzip failed: $zip" }
  New-Item -ItemType Directory -Force $markerDir | Out-Null
  Get-ChildItem $markerDir -Force -Filter '.pin-*' -ErrorAction SilentlyContinue | Remove-Item -Force
  Set-Content -Path $marker -Value $tag -Encoding ascii
}

function Find-Exe($dir, $name) {
  $f = Get-ChildItem -Path $dir -Recurse -Filter $name -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($f) { return $f.FullName }
  return $null
}

function Add-MachinePath($dir) {
  $cur = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $parts = $cur -split ';' | Where-Object { $_ }
  if (-not ($parts | Where-Object { $_.TrimEnd('\') -ieq $dir.TrimEnd('\') })) {
    [Environment]::SetEnvironmentVariable('Path', (($parts + $dir) -join ';'), 'Machine')
  }
}

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Make-Shortcut($name, $target, $workdir) {
  if (-not $target -or -not (Test-Path $target)) { Warn "no shortcut for $name (target missing)"; return }
  $wsh = New-Object -ComObject WScript.Shell
  $lnk = $wsh.CreateShortcut("$Desktop\$name.lnk")
  $lnk.TargetPath = $target
  $lnk.WorkingDirectory = $(if ($workdir) { $workdir } else { Split-Path $target })
  $lnk.Save()
}

function Run-Capture($exe, [string[]]$argList, $timeoutSec = 60) {
  # Native tools write banners to stderr; with $ErrorActionPreference='Stop' a `2>&1` redirect would turn
  # those lines into terminating errors in Windows PowerShell 5.1. Capture both streams explicitly instead.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = (($argList | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' ')
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.RedirectStandardInput = $true
  $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $p.StandardInput.Close()
  $o = $p.StandardOutput.ReadToEndAsync()
  $e = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($timeoutSec * 1000)) {
    try { $p.Kill() } catch { }
    return @{ Exit = -1; Out = ''; TimedOut = $true }
  }
  $p.WaitForExit()
  # sigcheck/procdump emit UTF-16 text when stdout is redirected; decoded as OEM it is full of NULs. Drop them.
  return @{ Exit = $p.ExitCode; Out = (($o.Result + "`n" + $e.Result) -replace "`0", ''); TimedOut = $false }
}

function Reg-Add($key, $name, $value) {
  reg.exe add $key /v $name /t REG_DWORD /d $value /f | Out-Null
  if ($LASTEXITCODE) { throw "reg add failed: $key" }
}

New-Item -ItemType Directory -Force $Tools, $Cache, $Samples, $Desktop | Out-Null

# ---- Defender --------------------------------------------------------------------------------------------
# Defender flags several of these tools as malware (capa/FLOSS ship detection rules and sample strings; x64dbg,
# dnSpy and procdump are common false positives) and deletes or refuses the download. This is a disposable
# analysis VM, so exclude the tools directory (and nothing else); real-time protection stays on elsewhere.
Log 'defender exclusion'
try {
  Add-MpPreference -ExclusionPath $Tools -ErrorAction Stop
  Write-Output "  excluded: $((Get-MpPreference).ExclusionPath -join ', ')"
} catch {
  Write-Output "  WARN could not add the Defender exclusion: $($_.Exception.Message)"
}

# ---- stop whatever a previous run left running (locked exes cannot be replaced) ------------------------
Log 'stop previous run'
foreach ($n in 'WinRE-Toolbox', 'WinRE-Wireshark', 'WinRE-X64dbg') {
  if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue }
}
Get-Process x64dbg, x32dbg, x96dbg, Procmon, Procmon64, procexp, procexp64, Autoruns, Autoruns64, autorunsc64, sigcheck64, `
  procdump64, handle64, Listdlls64, strings64, PE-bear, die, diec, ILSpy, dnSpy, capa, floss, ilspycmd, wireshark, tshark, dumpcap `
  -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 2

# ---- download ----------------------------------------------------------------------------------------
Log 'download'
Fetch $X64dbgUrl $X64dbgSha "$Cache\$X64dbgZip"
Fetch $PeBearUrl $PeBearSha "$Cache\$PeBearZip"
Fetch $DieUrl $DieSha "$Cache\$DieZip"
Fetch $IlspyUrl $IlspySha "$Cache\$IlspyZip"
Fetch $DnspyUrl $DnspySha "$Cache\$DnspyZip"
Fetch $CapaUrl $CapaSha "$Cache\$CapaZip"
Fetch $FlossUrl $FlossSha "$Cache\$FlossZip"
Fetch $DotnetUrl $DotnetSha512 "$Cache\dotnet-sdk-$DotnetVer.exe"
Fetch $WsUrls $WsSha "$Cache\$WsExe"
# No published hash: always re-download, verify signatures below.
Fetch $SysintUrl '' "$Cache\SysinternalsSuite.zip"
Fetch $VcRedistUrl '' "$Cache\vc_redist.x64.exe"

# ---- Visual C++ runtime (PE-bear and friends link it dynamically) --------------------------------------
Log 'vc++ runtime'
$sig = Get-AuthenticodeSignature "$Cache\vc_redist.x64.exe"
if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
  throw "vc_redist signature check failed: $($sig.Status) $($sig.SignerCertificate.Subject)"
}
# 1638 = a newer redistributable is already installed; 3010 = reboot suggested.
$p = Start-Process "$Cache\vc_redist.x64.exe" -Wait -PassThru -ArgumentList @('/install', '/quiet', '/norestart')
if ($p.ExitCode -notin 0, 1638, 3010) { throw "vc_redist install failed: $($p.ExitCode)" }

# ---- Sysinternals ------------------------------------------------------------------------------------
Log 'sysinternals suite'
New-Item -ItemType Directory -Force $SysDir | Out-Null
tar.exe -xf "$Cache\SysinternalsSuite.zip" -C $SysDir
if ($LASTEXITCODE) { throw 'sysinternals unzip failed' }
$SysUsed = 'sigcheck64.exe', 'strings64.exe', 'handle64.exe', 'Listdlls64.exe', 'procdump64.exe', 'autorunsc64.exe',
           'Procmon64.exe', 'procexp64.exe', 'Autoruns64.exe', 'PsExec64.exe'
foreach ($f in $SysUsed) {
  $path = "$SysDir\$f"
  if (-not (Test-Path $path)) { Warn "$f not in the suite zip"; continue }
  $s = Get-AuthenticodeSignature $path
  if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
    Remove-Item -Force $path
    throw "Authenticode check failed for $f ($($s.Status)); removed it"
  }
}
Write-Output "  suite zip sha256: $((Get-FileHash "$Cache\SysinternalsSuite.zip" -Algorithm SHA256).Hash)"
Add-MachinePath $SysDir

# Accept the EULAs non-interactively: HKCU\Software\Sysinternals\<tool>\EulaAccepted=1 in the desktop user's
# hive and in .DEFAULT (the SYSTEM account, which the MCP services run as). Tools are also run with -accepteula.
$EulaTools = 'Sigcheck', 'Strings', 'Handle', 'ListDLLs', 'ProcDump', 'Autoruns', 'Process Monitor', 'Process Explorer',
             'PsExec', 'TCPView', 'DebugView', 'AccessChk', 'Streams', 'Sysmon'
$DesktopUser = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon').DefaultUserName
if (-not $DesktopUser) { $DesktopUser = 'vmhub' }
function Set-Eula($hive) {
  foreach ($t in $EulaTools) { Reg-Add "$hive\Software\Sysinternals\$t" 'EulaAccepted' 1 }
}
Log "sysinternals EULAs (SYSTEM + $DesktopUser)"
Set-Eula 'HKU\.DEFAULT'
try {
  $sid = (New-Object System.Security.Principal.NTAccount($DesktopUser)).Translate([System.Security.Principal.SecurityIdentifier]).Value
  if (Test-Path "Registry::HKEY_USERS\$sid") {
    Set-Eula "HKU\$sid"
  } else {
    $dat = "C:\Users\$DesktopUser\NTUSER.DAT"
    if (Test-Path $dat) {
      reg.exe load 'HKU\vmhub_eula' $dat | Out-Null
      if ($LASTEXITCODE) { throw 'reg load failed' }
      try { Set-Eula 'HKU\vmhub_eula' } finally {
        [GC]::Collect(); [GC]::WaitForPendingFinalizers()
        reg.exe unload 'HKU\vmhub_eula' | Out-Null
      }
    } else { Warn "no profile for $DesktopUser yet; EULAs rely on -accepteula" }
  }
} catch { Warn "could not pre-accept EULAs for ${DesktopUser}: $_" }

# ---- GUI + CLI tools from GitHub -----------------------------------------------------------------------
Log "x64dbg $X64dbgTag"
Unpack "$Cache\$X64dbgZip" $X64Dir $X64dbgTag
icacls.exe $X64Dir /grant "${UsersSid}:(OI)(CI)M" | Out-Null   # x64dbg writes its .ini / databases next to the exe

Log "pe-bear $PeBearTag"
Unpack "$Cache\$PeBearZip" $PeBearDir $PeBearTag

Log "detect it easy $DieTag (die.exe GUI + diec.exe CLI)"
Unpack "$Cache\$DieZip" $Tools $DieTag $DieDir     # the zip's top folder is die\
Add-MachinePath $DieDir

Log "ilspy $IlspyTag"
Unpack "$Cache\$IlspyZip" $IlspyDir $IlspyTag

Log "dnSpyEx $DnspyTag"
Unpack "$Cache\$DnspyZip" $DnspyDir $DnspyTag

Log "capa $CapaTag"
Unpack "$Cache\$CapaZip" $CapaDir $CapaTag
Add-MachinePath $CapaDir

Log "floss $FlossTag"
Unpack "$Cache\$FlossZip" $FlossDir $FlossTag
Add-MachinePath $FlossDir

# ---- .NET SDK + ilspycmd ---------------------------------------------------------------------------------
Log ".net sdk $DotnetVer"
$have = $false
if (Test-Path $Dotnet) {
  $r = Run-Capture $Dotnet @('--list-sdks') 60
  if ($r.Out -match [regex]::Escape($DotnetVer)) { $have = $true }
}
if (-not $have) {
  $p = Start-Process "$Cache\dotnet-sdk-$DotnetVer.exe" -Wait -PassThru -ArgumentList @('/install', '/quiet', '/norestart')
  if ($p.ExitCode -notin 0, 3010) { throw ".NET SDK install failed: $($p.ExitCode)" }
}
[Environment]::SetEnvironmentVariable('DOTNET_CLI_TELEMETRY_OPTOUT', '1', 'Machine')
[Environment]::SetEnvironmentVariable('DOTNET_NOLOGO', '1', 'Machine')
[Environment]::SetEnvironmentVariable('DOTNET_SKIP_FIRST_TIME_EXPERIENCE', '1', 'Machine')
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'; $env:DOTNET_NOLOGO = '1'; $env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$env:DOTNET_CLI_HOME = "$Tools\_dotnet-home"
New-Item -ItemType Directory -Force $env:DOTNET_CLI_HOME | Out-Null
Add-MachinePath 'C:\Program Files\dotnet'
Refresh-Path

Log "ilspycmd $IlspyCmdVer -> $DnToolDir"
# The package is signed by nuget.org and dotnet verifies that signature on install; the version is pinned.
New-Item -ItemType Directory -Force $DnToolDir | Out-Null
& $Dotnet tool update ilspycmd --tool-path $DnToolDir --version $IlspyCmdVer
if ($LASTEXITCODE -or -not (Test-Path "$DnToolDir\ilspycmd.exe")) {
  & $Dotnet tool install ilspycmd --tool-path $DnToolDir --version $IlspyCmdVer
  if ($LASTEXITCODE) { throw 'ilspycmd install failed' }
}
Add-MachinePath $DnToolDir

# ---- Wireshark (analysis only; no Npcap, see header) ------------------------------------------------------
Log "wireshark $WsVer (silent, no Npcap)"
if (-not (Test-Path "$WsDir\tshark.exe")) {
  # /D must be the last argument and must not be quoted, even with spaces in the path. /desktopicon=no: we
  # create our own shortcut. Components other than the defaults are not needed.
  $p = Start-Process "$Cache\$WsExe" -Wait -PassThru -ArgumentList @('/S', '/desktopicon=no', "/D=$WsDir")
  if ($p.ExitCode -notin 0, 3010) { throw "Wireshark install failed: $($p.ExitCode)" }
  foreach ($i in 1..60) { if (Test-Path "$WsDir\tshark.exe") { break }; Start-Sleep 2 }   # NSIS may return early
  if (-not (Test-Path "$WsDir\tshark.exe")) { throw 'tshark.exe did not appear after the Wireshark install' }
}
Add-MachinePath $WsDir

# ---- WinDbg (Microsoft Store app; best effort, never fatal) -----------------------------------------------
Log 'windbg (best effort)'
$WinDbgOk = $false
try {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($winget) {
    # winget is a per-user App Installer feature: it usually does not work under SYSTEM. Rerun this script
    # (or just this command) as the desktop user if it is skipped here.
    $r = Run-Capture $winget.Source @('install', '--id', 'Microsoft.WinDbg', '--source', 'winget',
      '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity') 900
    if ($r.Exit -eq 0 -or $r.Out -match 'already installed') { $WinDbgOk = $true } else { Warn "winget WinDbg exit $($r.Exit)" }
  } else {
    Warn 'winget.exe not found; skipping WinDbg (install Microsoft.WinDbg from the Store as the desktop user)'
  }
} catch { Warn "WinDbg install skipped: $_" }

# ---- shared folders, shortcuts -----------------------------------------------------------------------------
Log 'samples folder + shortcuts'
icacls.exe $Samples /grant "${UsersSid}:(OI)(CI)M" | Out-Null

$Exe = @{
  x64dbg  = "$X64Dir\release\x96dbg.exe"
  pebear  = (Find-Exe $PeBearDir 'PE-bear.exe')
  die     = "$DieDir\die.exe"
  ilspy   = (Find-Exe $IlspyDir 'ILSpy.exe')
  dnspy   = (Find-Exe $DnspyDir 'dnSpy.exe')
  wshark  = "$WsDir\Wireshark.exe"
  procmon = "$SysDir\Procmon64.exe"
  procexp = "$SysDir\procexp64.exe"
  autoruns = "$SysDir\Autoruns64.exe"
  tcpview = $(if (Test-Path "$SysDir\Tcpview.exe") { "$SysDir\Tcpview.exe" } else { "$SysDir\tcpview64.exe" })
}
Make-Shortcut 'x64dbg' $Exe.x64dbg $X64Dir
Make-Shortcut 'PE-bear' $Exe.pebear $null
Make-Shortcut 'Detect It Easy' $Exe.die $DieDir
Make-Shortcut 'ILSpy' $Exe.ilspy $null
Make-Shortcut 'dnSpyEx' $Exe.dnspy $null
Make-Shortcut 'Wireshark' $Exe.wshark $null
Make-Shortcut 'Process Monitor' $Exe.procmon $SysDir
Make-Shortcut 'Process Explorer' $Exe.procexp $SysDir
Make-Shortcut 'Autoruns' $Exe.autoruns $SysDir
Make-Shortcut 'TCPView' $Exe.tcpview $SysDir
Make-Shortcut 're-samples' $Samples $Samples

# ---- verify ------------------------------------------------------------------------------------------------
Log 'verify'
Refresh-Path

function Check-Cli($label, $exe, [string[]]$argList, $pattern, $timeoutSec = 120) {
  if (-not $exe -or -not (Test-Path $exe)) { Write-Output "  MISSING $label (not found)"; $script:Missing.Add($label); return }
  try {
    $r = Run-Capture $exe $argList $timeoutSec
    if ($r.TimedOut) { Write-Output "  MISSING $label (timed out)"; $script:Missing.Add($label); return }
    # Sysinternals tools exit non-zero when run with only -accepteula, so match the banner text instead.
    if ($r.Out -match $pattern) {
      $first = ($r.Out -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
      Write-Output "  ok   $label  ($($first.Trim()))"
    } else {
      Write-Output "  MISSING $label (unexpected output: $(($r.Out -split "`r?`n" | Select-Object -First 2) -join ' | '))"
      $script:Missing.Add($label)
    }
  } catch { Write-Output "  MISSING $label ($_)"; $script:Missing.Add($label) }
}

function Check-File($label, $path) {
  if ($path -and (Test-Path $path) -and ((Get-Item $path).Length -gt 0)) { Write-Output "  ok   $label  ($path)" }
  else { Write-Output "  MISSING $label"; $script:Missing.Add($label) }
}

# sigcheck and procdump print nothing when run with only -accepteula: ask for usage instead.
Check-Cli 'sigcheck'  "$SysDir\sigcheck64.exe"  @('-accepteula', '-?') 'Sigcheck|usage'
Check-Cli 'strings'   "$SysDir\strings64.exe"   @('-accepteula') 'Strings'
Check-Cli 'handle'    "$SysDir\handle64.exe"    @('-accepteula', '-p', '__none__') 'Handle'
Check-Cli 'listdlls'  "$SysDir\Listdlls64.exe"  @('-accepteula', '__none__') 'ListDLLs'
Check-Cli 'procdump'  "$SysDir\procdump64.exe"  @('-accepteula', '-?') 'ProcDump'
Check-Cli 'autorunsc' "$SysDir\autorunsc64.exe" @('-accepteula', '-a', 'b') 'Autoruns'
Check-File 'procmon (not executed: opens a GUI)' "$SysDir\Procmon64.exe"
Check-File 'procexp' "$SysDir\procexp64.exe"
Check-File 'autoruns' "$SysDir\Autoruns64.exe"
Check-Cli 'diec'      "$DieDir\diec.exe"        @('--version') '\d'
# capa is a large PyInstaller binary: its first start unpacks and gets scanned, so allow plenty of time.
Check-Cli 'capa'      "$CapaDir\capa.exe"       @('--version') '\d' 300
Check-Cli 'floss'     "$FlossDir\floss.exe"     @('--version') '\d'
Check-Cli 'dotnet'    $Dotnet                   @('--version') '^\s*\d+\.\d+'
Check-Cli 'ilspycmd'  "$DnToolDir\ilspycmd.exe" @('--version') '\d'
Check-Cli 'tshark'    "$WsDir\tshark.exe"       @('--version') 'TShark'
Check-File 'x64dbg'   "$X64Dir\release\x64\x64dbg.exe"
Check-File 'x96dbg'   "$X64Dir\release\x96dbg.exe"
Check-File 'pe-bear'  $Exe.pebear
Check-File 'die (gui)' "$DieDir\die.exe"
Check-File 'ilspy (gui)' $Exe.ilspy
Check-File 'dnspy'    $Exe.dnspy
Check-File 'wireshark (gui)' $Exe.wshark
if (-not (Test-Path $Samples)) { Write-Output '  MISSING re-samples'; $Missing.Add('re-samples') } else { Write-Output "  ok   re-samples  ($Samples)" }

# WinDbg is optional: report but never fail on it.
$windbgPkg = $null
try { $windbgPkg = Get-AppxPackage -AllUsers -Name 'Microsoft.WinDbg*' -ErrorAction SilentlyContinue | Select-Object -First 1 } catch { }
if ($windbgPkg) { Write-Output "  ok   windbg  ($($windbgPkg.Version))" } else { Write-Output '  skip windbg  (not installed; optional)' }

Remove-Item -Recurse -Force $Cache -ErrorAction SilentlyContinue
if ($Missing.Count) { throw "required tools missing: $($Missing -join ', ')" }
Log 'done'
