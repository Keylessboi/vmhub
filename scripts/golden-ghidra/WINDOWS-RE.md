# Windows RE layer

Added on top of the Ghidra golden (`install-windows.ps1`) by two scripts, run elevated in a
staging clone, in this order:

1. `install-windows-re-tools.ps1` - the tools.
2. `install-windows-re-mcp.ps1 [-ToolboxSrc C:\Tools\mcp\winre-toolbox]` - the MCP servers.
   Copy `mcp/winre-toolbox/` to `ToolboxSrc` first.

Both are idempotent, pure ASCII, log `== step` lines and end with `== done` only on success.

## MCP endpoints

All are `http://<vm-ip>:<port>/mcp` (streamable-http).

| Port | Server | Runs as | Notes |
|---|---|---|---|
| 8081 | GhidraMCP bridge | SYSTEM, startup | install-windows.ps1 |
| 8083 | x64dbg-mcp 1.3.1 (npm) | vmhub, at logon, interactive | starts x64dbg windows on demand; no auth |
| 8085 | wireshark-mcp 3.0.0 | SYSTEM, startup | own venv (mcp 2.x); analysis of pcaps |
| 8086 | winre-toolbox | SYSTEM, startup | 15 tools, see `mcp/winre-toolbox/README.md` |
| 8089 | GhidraMCP headless REST | SYSTEM, startup | localhost only |

Tasks: `WinRE-X64dbg`, `WinRE-Wireshark`, `WinRE-Toolbox` (restart every minute on failure).
Launchers and logs: `C:\Tools\winre-mcp\{x64dbg,wireshark,toolbox}.{ps1,log}`.
Inbound firewall rule "WinRE MCP" admits 8083/8085/8086 from 10.10.10.0/24.

## Tools and paths

| Tool | Path | Kind |
|---|---|---|
| Sysinternals Suite (sigcheck, strings, handle, listdlls, procdump, autorunsc, procmon, procexp, autoruns, ...) | `C:\Tools\sysinternals` (on PATH) | CLI, procmon/procexp/autoruns/tcpview GUI |
| x64dbg snapshot 2026.05.27 | `C:\Tools\x64dbg\release\x96dbg.exe` (launcher), `x64\x64dbg.exe` | GUI only |
| PE-bear 0.7.2 | `C:\Tools\pe-bear` | GUI only |
| Detect It Easy 3.21 | `C:\Tools\die` (`diec.exe` on PATH) | GUI + CLI |
| ILSpy 11.1 / ilspycmd 11.1.0.9782 | `C:\Tools\ilspy`, `C:\Tools\dotnet-tools` (on PATH) | GUI / CLI |
| dnSpyEx 6.6.0 | `C:\Tools\dnspy` | GUI only |
| capa 9.4.0, FLOSS 3.1.1 | `C:\Tools\capa`, `C:\Tools\floss` (on PATH) | CLI |
| .NET SDK 10.0.401 | `C:\Program Files\dotnet` | runtime for ilspycmd |
| Wireshark 4.6.9 (tshark, no Npcap) | `C:\Program Files\Wireshark` (on PATH) | GUI + CLI |
| WinDbg | Microsoft Store app | GUI only, optional |
| Node.js 24.21.0 | `C:\Program Files\nodejs` | runs x64dbg-mcp |
| Samples drop folder | `C:\Tools\re-samples` (Users: modify) | |

Shortcuts for the GUI tools are on `C:\Users\Public\Desktop`.
Pip venvs: `C:\Tools\winre-mcp-venv` (toolbox), `C:\Tools\winre-wireshark-venv` (wireshark-mcp).
x64dbg-mcp: `C:\Tools\x64dbg-mcp\npm`, config `C:\Tools\x64dbg-mcp\config.env`.

The toolbox only touches `C:\Users\vmhub`, `C:\Users\Public`, `C:\Tools\re-samples`, `C:\Windows\Temp`
and `RE_TOOLBOX_ROOTS`; put samples in `C:\Tools\re-samples`.

## Known limitations

- No live packet capture inside the guest. Silent Wireshark installs skip Npcap and the free Npcap
  installer cannot run silently, so capture is done on the Proxmox host (`vm_capture`); tshark and
  wireshark-mcp here only read pcaps. `dumpcap` is present but has no capture driver.
- No Bluetooth emulation on Windows (bt-emu is Linux only).
- GUI-only: x64dbg, PE-bear, die.exe, ILSpy, dnSpyEx, Wireshark, WinDbg, Process Monitor/Explorer,
  Autoruns, TCPView. Drive them through the desktop (CursorTouch); their CLI/MCP counterparts are
  x64dbg-mcp, diec, ilspycmd, tshark, procmon_capture_*, autoruns_scan.
- Process Monitor needs administrator rights; the toolbox runs as SYSTEM so `procmon_capture_*` works,
  but the capture is global to the machine and only one can run at a time.
- x64dbg-mcp has no authentication and a single debug session at a time (MAX_SESSIONS=1).
- WinDbg comes from `winget` and normally fails under SYSTEM; the script warns and continues. Rerun the
  winget command as the desktop user if needed.
- The Sysinternals Suite is downloaded from a fixed URL that is updated in place, so its hash changes;
  integrity is Authenticode-checked per exe, not pinned.
- ilspycmd 11.x targets net10.0, hence .NET SDK 10 rather than 8 or 9.
