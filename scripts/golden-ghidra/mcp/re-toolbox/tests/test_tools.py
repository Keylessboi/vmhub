import os

from re_toolbox_mcp import core, tools

FAKE_STRACE = r'''@LOG@
while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then f="$2"; fi; shift; done
printf '100 12:00:00.000001 execve("/x", ["x"], []) = 0\n' > "$f"
printf '100 12:00:00.000002 openat(AT_FDCWD, "a", O_RDONLY) = 3\n' >> "$f"
printf '[pid 101] 12:00:00.000003 openat(AT_FDCWD, "b", O_RDONLY) = 4\n' >> "$f"
echo child-out
'''


# ---------------------------------------------------------------- argv / parsing

def test_strace_argv_and_summary(fake):
    fake.make("strace", FAKE_STRACE)
    r = tools.strace_run(["echo", "hi"], filter="trace=file")
    assert r["exit_code"] == 0
    a = fake.args()
    assert a.startswith("-tt -f -e trace=file -o ")
    assert a.endswith(" -- echo hi")
    assert r["summary"]["total"] == 3
    assert r["summary"]["top"]["openat"] == 2
    assert "openat" in r["trace"] and "child-out" in r["stdout"]
    assert set(r) >= {"exit_code", "stdout", "stderr", "truncated", "duration_s"}


def test_strace_no_follow_forks(fake):
    fake.make("strace", FAKE_STRACE)
    tools.strace_run(["echo"], follow_forks=False)
    assert " -f " not in " " + fake.args() + " "


def test_valgrind_tool_and_callgrind(fake):
    fake.make("valgrind", '@LOG@\n')
    r = tools.valgrind_run(["prog", "x"], tool="callgrind")
    a = fake.args()
    assert "--tool=callgrind" in a and "--callgrind-out-file=" in a and a.endswith(" prog x")
    assert r["callgrind_out"] is None  # fake wrote nothing
    assert "error" in tools.valgrind_run(["prog"], tool="drd")


def test_yara_args_and_parse(fake, sample):
    fake.make("yara", '@LOG@\necho "rule1 $4"\necho "0x0:\\$a: ELF"\n')
    r = tools.yara_scan(sample, rules_text="rule rule1 { condition: true }")
    assert fake.args().startswith("-s -r ") and fake.args().endswith(sample)
    assert r["matches"] == [{"rule": "rule1", "target": sample, "strings": ["0x0:$a: ELF"]}]


def test_yara_requires_exactly_one(fake, sample):
    assert "exactly one" in tools.yara_scan(sample)["error"]
    assert "exactly one" in tools.yara_scan(sample, rules_text="x", rules_path=sample)["error"]


def test_upx(fake, sample, tmp_path):
    fake.make("upx", '@LOG@\nif [ "$1" = "-d" ]; then echo x > "$3"; fi\n')
    assert tools.upx_info(sample)["packed"] is True
    assert fake.args() == f"-t {sample}"
    out = str(tmp_path / "unpacked")
    r = tools.upx_unpack(sample, out)
    assert fake.args() == f"-d -o {out} {sample}"
    assert r["output_exists"] is True
    assert "already exists" in tools.upx_unpack(sample, out)["error"]


def test_binwalk_extract(fake, sample):
    fake.make("binwalk", '@LOG@\nif [ "x$1" = "x-e" ]; then mkdir -p "$3/sub"; echo hi > "$3/sub/f"; fi\n')
    tools.binwalk_scan(sample)
    assert fake.args() == sample
    r = tools.binwalk_scan(sample, extract=True)
    assert r["extract_dir"].startswith(str(fake.tmp / "work" / "extract"))
    assert [f["size"] for f in r["files"]] == [3]
    assert fake.args().startswith("-e -C ")


def test_file_info(fake, sample):
    fake.make("file", 'echo "ELF fake"\n')
    fake.make("readelf", 'echo "readelf $1"\n')
    fake.make("strings", 'i=0; while [ $i -lt 500 ]; do echo "string-number-$i"; i=$((i+1)); done\n')
    r = tools.file_info(sample)
    assert r["is_elf"] and r["file"] == "ELF fake"
    assert r["elf_header"].startswith("readelf -h")
    assert len(r["strings"].splitlines()) == 200
    assert r["missing_binaries"] == []


def test_file_info_objdump_fallback(fake, sample):
    fake.make("file", "echo x\n")
    fake.make("objdump", "echo objdump-f\n")
    r = tools.file_info(sample)
    assert r["objdump_f"].strip() == "objdump-f"
    assert "readelf" in r["missing_binaries"] and "strings" in r["missing_binaries"]


def test_qemu(fake, sample):
    fake.make("qemu-aarch64-static", '@LOG@\n')
    r = tools.qemu_user_run("aarch64", sample, ["a", "b"], strace_syscalls=True)
    assert r["exit_code"] == 0
    assert fake.args() == f"-strace {sample} a b"
    assert "arch must be" in tools.qemu_user_run("sparc", sample)["error"]


def test_angr_and_mitm_flows_use_re_python(fake, sample):
    fake.make("re-python", '@LOG@\necho \'@@RESULT@@{"function_count": 3}\'\n')
    r = tools.angr_cfg(sample, max_functions=7)
    assert r["result"] == {"function_count": 3}
    assert fake.args().startswith("-I -c ") and fake.args().endswith(f" {sample} 7")
    r = tools.angr_find(sample, 0x401000, [0x401100], symbolic_argv_len=4)
    assert fake.args().endswith(f" {sample} 4198400 [16640] 4") or "4198400" in fake.args()
    assert r["result"]["function_count"] == 3
    assert "non-negative" in tools.angr_find(sample, -1)["error"]


def test_re_python_missing(fake, sample):
    r = tools.angr_cfg(sample)
    assert "RE_PYTHON" in r["error"] and r["missing_binary"]


# ---------------------------------------------------------------- caps / timeouts

def test_output_cap_keeps_tail(fake):
    fake.make("ltrace", 'i=0; while [ $i -lt 3000 ]; do echo "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx$i"; i=$((i+1)); done\n')
    r = tools.ltrace_run(["prog"])
    assert r["truncated"] is True
    assert len(r["stdout"].encode()) <= core.OUTPUT_CAP
    assert r["stdout"].rstrip().endswith("2999")


def test_timeout_kills(fake):
    fake.make("ltrace", "while :; do :; done\n")
    r = tools.ltrace_run(["prog"], timeout_s=1)
    assert r["timed_out"] is True and "timed out" in r["error"]
    assert r["duration_s"] < 10


def test_timeout_clamped():
    assert core.clamp_timeout(10_000) == 600
    assert core.clamp_timeout(0) == 1


# ---------------------------------------------------------------- sandbox

def test_path_outside_roots_rejected(fake):
    r = tools.file_info("/etc/passwd")
    assert "outside allowed roots" in r["error"]


def test_symlink_escape_rejected(fake, tmp_path):
    link = tmp_path / "evil"
    os.symlink("/etc/passwd", link)
    assert "outside allowed roots" in tools.file_info(str(link))["error"]


def test_dotdot_escape_rejected(fake, tmp_path):
    assert "outside allowed roots" in tools.file_info(str(tmp_path) + "/../../../../../../etc/passwd")["error"]


def test_extra_roots_env(fake, monkeypatch):
    fake.make("file", "echo x\n")
    assert "error" in tools.file_info("/etc/passwd")
    monkeypatch.setenv("RE_TOOLBOX_ROOTS", "/nonexistent:/etc")
    assert "error" not in tools.file_info("/etc/passwd")


def test_command_path_sandboxed(fake):
    fake.make("strace", FAKE_STRACE)
    assert "outside allowed roots" in tools.strace_run(["/bin/ls"])["error"]


def test_non_string_argv_rejected(fake):
    fake.make("strace", FAKE_STRACE)
    assert "non-string" in tools.strace_run(["ls", 5])["error"]
    assert "non-empty list" in tools.strace_run([])["error"]
    assert "non-empty list" in tools.strace_run("ls -l")["error"]
    fake.make("qemu-arm-static", "true\n")
    assert "non-string" in tools.qemu_user_run("arm", "/tmp", [1])["error"]


# ---------------------------------------------------------------- missing binaries

def test_missing_binaries_degrade(fake, sample):
    assert tools.strace_run(["ls"])["missing_binary"] == "strace"
    assert tools.ltrace_run(["ls"])["missing_binary"] == "ltrace"
    assert tools.valgrind_run(["ls"])["missing_binary"] == "valgrind"
    assert tools.binwalk_scan(sample)["missing_binary"] == "binwalk"
    assert tools.yara_scan(sample, rules_text="x")["missing_binary"] == "yara"
    assert tools.upx_info(sample)["missing_binary"] == "upx"
    assert tools.qemu_user_run("mips", sample)["missing_binary"] == "qemu-mips-static"
    assert tools.mitm_capture_start()["missing_binary"] == "mitmdump"
    assert "strace" in tools.strace_run(["ls"])["error"]


def test_tool_versions_reports_missing(fake):
    fake.make("strace", 'echo "strace -- version 6.9"\n')
    r = tools.tool_versions()
    assert r["tools"]["strace"] == {"installed": True, "version": "strace -- version 6.9"}
    assert r["tools"]["upx"]["installed"] is False
    assert "upx" in r["missing"] and "python:angr" in r["missing"]


# ---------------------------------------------------------------- mitm

def test_mitm_waits_until_listening(fake, tmp_path, monkeypatch):
    # The fake binds the requested port after a short delay; start must not return before it accepts connections.
    import socket
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    import sys
    fake.make("mitmdump", '@LOG@\nexec %s -c "import socket,time; time.sleep(1.0); s=socket.socket(); '
              's.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind((\'127.0.0.1\', %d)); s.listen(); time.sleep(30)"\n' % (sys.executable, port))
    r = tools.mitm_capture_start(port, str(tmp_path / "w" / "f.flows"))
    assert r["started"] and r["listening"] is True
    with socket.create_connection(("127.0.0.1", port), timeout=2):
        pass
    tools.mitm_capture_stop()


def test_mitm_reports_not_listening(fake, tmp_path, monkeypatch):
    monkeypatch.setattr(tools, "_MITM_READY_TIMEOUT_S", 1.0)
    fake.make("mitmdump", '@LOG@\nexec sleep 30\n')
    r = tools.mitm_capture_start(9099, str(tmp_path / "n" / "f.flows"))
    assert r["started"] and r["listening"] is False and "not accepting" in r["warning"]
    tools.mitm_capture_stop()


def test_mitm_lifecycle(fake, tmp_path, monkeypatch):
    monkeypatch.setattr(tools, "_MITM_READY_TIMEOUT_S", 0.5)
    fake.make("mitmdump", '@LOG@\nexec sleep 30\n')
    fake.make("re-python", 'echo \'@@RESULT@@{"total": 0, "returned": 0, "flows": []}\'\n')
    flows = str(tmp_path / "cap" / "f.flows")
    r = tools.mitm_capture_start(9090, flows)
    assert r["started"] and r["flows_file"] == flows
    import time; time.sleep(0.2)
    assert fake.args() == f"--listen-port 9090 -w {flows}"
    again = tools.mitm_capture_start()
    assert "already running" in again["error"]
    open(flows, "w").close()
    assert tools.mitm_flows()["result"]["total"] == 0
    s = tools.mitm_capture_stop()
    assert s["stopped"] and s["was_running"]
    assert "no capture" in tools.mitm_capture_stop()["error"]
    assert tools.mitm_capture_start(9091, flows)["started"]  # can restart after stop


def test_mitm_bad_inputs(fake):
    assert "listen_port" in tools.mitm_capture_start(0)["error"]
    assert "outside allowed roots" in tools.mitm_capture_start(8080, "/etc/flows")["error"]
    assert "no flows file" in tools.mitm_flows()["error"]
