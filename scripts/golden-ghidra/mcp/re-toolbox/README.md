# re-toolbox-mcp

MCP server for a disposable Debian 13 reverse-engineering lab VM. It lets an
agent drive strace, ltrace, valgrind, binwalk, yara, upx, qemu-user, angr and
mitmproxy through structured tools instead of a raw shell.

## Install

```
/opt/re-venv/bin/pip install .
sudo install -m 644 systemd/re-toolbox-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now re-toolbox-mcp
```

The system tools (`strace ltrace valgrind binwalk yara upx-ucl qemu-user-static
binutils file`) come from apt. `angr` and `mitmproxy` must be installed in
`RE_PYTHON` (default `/opt/re-venv/bin/python`); `mitmdump` must be on PATH
for the service user (e.g. `/opt/re-venv/bin` in PATH, or symlink it).
Optional env goes in `/etc/default/re-toolbox-mcp` (read by the unit).

Run by hand: `python -m re_toolbox_mcp [--host 0.0.0.0] [--port 8086] [--transport streamable-http|stdio]`.
The streamable-http endpoint is `http://<host>:8086/mcp`.

## Tools

Process tools return `exit_code, stdout, stderr, truncated, duration_s, timed_out`
(plus tool-specific keys). Errors come back as `{"error": ..., "exit_code": null}`;
an absent binary adds `missing_binary`.

| Tool | Purpose |
|---|---|
| `strace_run(command, timeout_s=30, follow_forks=True, filter=None)` | syscall trace (`trace`) + syscall count `summary` over the full trace |
| `ltrace_run(command, timeout_s=30)` | library-call trace |
| `valgrind_run(command, tool="memcheck", timeout_s=120)` | memcheck/callgrind/helgrind; `report`, `callgrind_out` |
| `binwalk_scan(path, extract=False)` | signature scan; extract to `/tmp/re-toolbox/extract/<uuid>` + file list |
| `yara_scan(path, rules_text=None, rules_path=None)` | exactly one rules source; parsed `matches` |
| `upx_info(path)` / `upx_unpack(path, output_path)` | `upx -t` / `upx -d -o` |
| `file_info(path)` | `file`, `readelf -h/-S` (or `objdump -f`), `strings -n 8` first 200 lines |
| `qemu_user_run(arch, binary, args=[], timeout_s=30, strace_syscalls=False, sysroot=None)` | run foreign ELF with `qemu-<arch>-static`; arch in aarch64, arm, mips, mipsel, riscv64, ppc64, x86_64, i386 |
| `angr_cfg(path, max_functions=200)` | CFGFast in a subprocess; function names/addrs/sizes |
| `angr_find(path, find, avoid=[], timeout_s=120, symbolic_argv_len=0)` | symbolic exploration; solved stdin / argv[1] |
| `mitm_capture_start(listen_port=8080, flows_file=None)` / `mitm_capture_stop()` / `mitm_flows(limit=100)` | single background `mitmdump -w`; flows parsed with `mitmproxy.io.FlowReader` under `RE_PYTHON` |
| `tool_versions()` | installed/missing tools and versions |

## Environment

| Variable | Meaning |
|---|---|
| `RE_TOOLBOX_TOKEN` | if set, HTTP requests need `Authorization: Bearer <token>` (401 otherwise); unset = no auth. Not applied to stdio. |
| `RE_TOOLBOX_ROOTS` | extra allowed path roots, colon-separated |
| `RE_PYTHON` | interpreter holding angr/mitmproxy (default `/opt/re-venv/bin/python`) |
| `RE_TOOLBOX_WORK` | scratch dir (default `/tmp/re-toolbox`; must stay under an allowed root for extraction output to be reusable) |

## Safety rules

- Every path argument is `realpath`-resolved and must lie under `/home/vmuser`,
  `/tmp`, `/opt/re-samples` or `RE_TOOLBOX_ROOTS` (symlink and `..` escapes are rejected).
  A path-like `command[0]` is sandboxed too; bare names resolve via PATH.
- Commands are argv lists; non-string elements are rejected; no shell is ever used.
- Timeouts are capped at 600 s; on timeout the whole process group is SIGKILLed.
- stdout/stderr/trace are each capped at 64 KiB, keeping the tail (`truncated: true`).
- Missing binaries yield an error dict naming the binary.

This is a sandbox for convenience, **not** a security boundary: the tools
execute arbitrary samples the agent points them at (strace/valgrind/qemu run
the target). Run only inside the disposable VM, and set `RE_TOOLBOX_TOKEN` and
firewall port 8086 if the VM network is shared.

## Tests

```
python -m venv /tmp/retoolbox-venv && /tmp/retoolbox-venv/bin/pip install mcp pytest
PYTHONPATH=. /tmp/retoolbox-venv/bin/python -m pytest -q
```

Tests use fake shell-script binaries on a temporary PATH; no real tool is needed.
