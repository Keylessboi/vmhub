# winre-toolbox-mcp

MCP server for the disposable Windows 11 reverse-engineering lab VM. It lets an
agent drive Sysinternals, Detect It Easy, capa, FLOSS, ilspycmd, Process Monitor,
tshark and pefile through structured tools instead of a raw shell. It is the
Windows counterpart of `mcp/re-toolbox`.

## Install

Done by `install-windows-re-mcp.ps1` (own venv `C:\Tools\winre-mcp-venv`, scheduled
task `WinRE-Toolbox`, SYSTEM, at startup, port 8086). By hand:

```
python -m venv C:\Tools\winre-mcp-venv
C:\Tools\winre-mcp-venv\Scripts\pip install .
C:\Tools\winre-mcp-venv\Scripts\python -m winre_toolbox_mcp --host 0.0.0.0 --port 8086
```

The streamable-http endpoint is `http://<host>:8086/mcp`. `--transport stdio` is
available for local clients. The CLIs come from `install-windows-re-tools.ps1`.

## Tools

Process tools return `exit_code, stdout, stderr, truncated, duration_s, timed_out`
(plus tool-specific keys). Errors come back as `{"error": ..., "exit_code": null}`;
an absent tool adds `missing_binary`.

| Tool | Purpose |
|---|---|
| `sigcheck_scan(path)` | Authenticode status, hashes, version info (`info` = parsed CSV record) |
| `strings_scan(path, min_length=6, kind="both", max_lines=2000)` | Sysinternals strings, ASCII and Unicode, with offsets, capped per kind |
| `diec_scan(path, deep=False, heuristic=False)` | Detect It Easy JSON (`detects`) |
| `capa_scan(path, top_rules=25)` | capa summary: ATT&CK and MBC tags, top rules |
| `floss_scan(path, min_length=6, include_static=False, max_strings=500)` | decoded / stack / tight strings, capped |
| `ilspy_decompile(path, mode="list"\|"type"\|"all", type_name, output_dir)` | list types, decompile one type, or the whole assembly to a folder |
| `procdump_run(pid \| command, output_dir, on_exception)` | `procdump -ma` on a pid or a launched program |
| `handle_list(pid \| process_name)` / `listdlls_list(pid)` | parsed open handles / loaded modules |
| `autoruns_scan(verify_signatures=False, hide_microsoft=False, max_rows=500)` | `autorunsc -a * -c` parsed, with per-category counts |
| `procmon_capture_start()` / `procmon_capture_stop(...)` | PML capture, then CSV conversion and a summary (top processes, file/registry/network counts, capped rows, optional process/path/category filters) |
| `tshark_summary(pcap, extra_stats=[])` | `-z conv,tcp` and `-z io,phs` (optionally udp, http, dns), head-capped |
| `pe_info(path)` | pefile: headers, sections with entropy, imports, exports, timestamp, imphash |
| `tool_versions()` | which tools are present, with their version banner |

## Environment

| Variable | Meaning |
|---|---|
| `RE_TOOLBOX_TOKEN` | if set, HTTP requests need `Authorization: Bearer <token>`; unset = no auth. Not applied to stdio. |
| `RE_TOOLBOX_ROOTS` | extra allowed path roots, `;`-separated on Windows |
| `RE_TOOLBOX_WORK` | scratch dir (default `C:\Windows\Temp\re-toolbox`) |
| `RE_TOOL_<NAME>` | override a tool location: `SIGCHECK STRINGS HANDLE LISTDLLS PROCDUMP AUTORUNSC PROCMON DIEC CAPA FLOSS ILSPYCMD TSHARK` |

Defaults live in `core.TOOL_DEFAULTS` (the `C:\Tools` layout); PATH is the last fallback.

## Safety rules

- Every path argument is normalised (`ntpath` on Windows, case-insensitive) and must lie
  under `C:\Users\vmhub`, `C:\Users\Public`, `C:\Tools\re-samples`, `C:\Windows\Temp` or
  `RE_TOOLBOX_ROOTS`. Rejected: UNC and `\\?\` / `\\.\` paths, other drives, `..` escapes,
  alternate data streams (`:`), wildcards, components ending in a dot or space (Win32 strips
  those), and junctions/symlinks that resolve outside the roots.
- Commands are argv lists, never a shell. A launched `command[0]` must be a full sandboxed path.
- Timeouts are capped at 600 s; on timeout the process tree is killed (`taskkill /T /F`).
- stdout/stderr are each capped at 64 KiB keeping the tail (head for source and tshark text);
  parsed tools stream the tool's output through a file so the summary covers all of it.
- Missing tools yield an error dict naming the tool.

This is a convenience sandbox, **not** a security boundary: procdump `command` and Process
Monitor run with SYSTEM rights. Use only inside the disposable VM and firewall port 8086.

## Tests

Run on Linux with fake shell-script tools; no Windows needed. The Windows path rules are tested
through `ntpath`.

```
python -m venv /tmp/winretoolbox-venv && /tmp/winretoolbox-venv/bin/pip install 'mcp>=1.28,<2' pytest pefile
PYTHONPATH=. /tmp/winretoolbox-venv/bin/python -m pytest -q
```
