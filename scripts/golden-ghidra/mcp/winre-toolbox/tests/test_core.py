import ntpath
import time

import pytest

from winre_toolbox_mcp import core
from winre_toolbox_mcp.core import ToolError, check_path, run_cmd

WIN_ROOTS = list(core.DEFAULT_ROOTS_WIN)


def win(p, **kw):
    return check_path(p, mod=ntpath, roots=WIN_ROOTS, exists=lambda _: True, **kw)


@pytest.mark.parametrize("p,expected", [
    (r"C:\Users\vmhub\a.exe", r"C:\Users\vmhub\a.exe"),
    (r"c:\users\VMHUB\A.exe", r"c:\users\VMHUB\A.exe"),          # case-insensitive match, original case kept
    ("C:/Users/Public/Desktop/x.exe", r"C:\Users\Public\Desktop\x.exe"),
    (r"C:\Users\vmhub\sub\..\a.exe", r"C:\Users\vmhub\a.exe"),   # stays inside after normalisation
    (r"C:\Tools\re-samples\\evil.exe", r"C:\Tools\re-samples\evil.exe"),
    (r"C:\Windows\Temp", r"C:\Windows\Temp"),                    # the root itself
])
def test_windows_sandbox_allows(p, expected):
    assert win(p) == expected


@pytest.mark.parametrize("p", [
    r"C:\Users\vmhub\..\Administrator\x",
    r"C:\Users\vmhub\..\..\Windows\System32\cmd.exe",
    r"C:\Users\vmhubby\x",                                      # prefix, not a path boundary
    r"C:\Windows\System32\cmd.exe",
    r"D:\Users\vmhub\x",
    r"\\server\share\x",
    r"//server/share/x",
    r"\\?\C:\Users\vmhub\x",
    r"\\.\PhysicalDrive0",
    r"C:\Users\vmhub\a.exe:Zone.Identifier",                    # alternate data stream
    r"C:\Users\vmhub\*.exe",
    "C:\\Users\\vmhub\\a|b",
    r"C:\Users\vmhub\.. \Windows\x",                            # Win32 strips the trailing space
    r"C:\Users\vmhub\...\x",
    r"Users\vmhub\x",
    r"C:Users\vmhub\x",
    "",
])
def test_windows_sandbox_rejects(p):
    with pytest.raises(ToolError):
        win(p)


def test_windows_sandbox_non_string_and_nul():
    for bad in (None, 5, ["C:\\x"], "C:\\Users\\vmhub\\a\x00b"):
        with pytest.raises(ToolError):
            win(bad)


def test_windows_sandbox_must_exist():
    with pytest.raises(ToolError, match="does not exist"):
        check_path(r"C:\Users\vmhub\x", mod=ntpath, roots=WIN_ROOTS, exists=lambda _: False)
    assert check_path(r"C:\Users\vmhub\x", mod=ntpath, roots=WIN_ROOTS, exists=lambda _: False,
                      must_exist=False) == r"C:\Users\vmhub\x"


def test_windows_sandbox_link_escape():
    # a junction inside the sandbox that points outside it
    real = lambda p: r"C:\Windows\System32\config" if p.endswith("link") else p  # noqa: E731
    with pytest.raises(ToolError, match="link"):
        check_path(r"C:\Users\vmhub\link", mod=ntpath, roots=WIN_ROOTS, exists=lambda _: True, real=real)
    ok = lambda p: r"\\?\C:\Users\Public\target" if p.endswith("link") else p  # noqa: E731
    assert check_path(r"C:\Users\vmhub\link", mod=ntpath, roots=WIN_ROOTS, exists=lambda _: True,
                      real=ok) == r"C:\Users\Public\target"


def test_roots_env_windows_uses_semicolon(monkeypatch):
    monkeypatch.setenv("RE_TOOLBOX_ROOTS", r"D:\Cases;E:\More Stuff")
    roots = core.roots_for(ntpath)
    assert r"D:\Cases" in roots and r"E:\More Stuff" in roots and r"C:\Users\vmhub" in roots
    assert check_path(r"e:\more stuff\a.bin", mod=ntpath, roots=roots, exists=lambda _: True)


def test_posix_flavour_used_on_linux(tmp_path, monkeypatch):
    monkeypatch.setenv("RE_TOOLBOX_ROOTS", str(tmp_path / "ok"))
    (tmp_path / "ok").mkdir()
    f = tmp_path / "ok" / "f"
    f.write_text("x")
    assert check_path(str(f)) == str(f)
    with pytest.raises(ToolError, match="outside allowed roots"):
        check_path("/etc/passwd")
    with pytest.raises(ToolError):
        check_path(str(tmp_path / "ok" / ".." / ".." / "etc" / "passwd"))
    link = tmp_path / "ok" / "lnk"
    link.symlink_to("/etc")
    with pytest.raises(ToolError, match="link"):
        check_path(str(link / "passwd"))


def test_check_command_requires_full_path(fake):
    with pytest.raises(ToolError, match="full path"):
        core.check_command(["cmd.exe", "/c", "dir"])
    p = fake.sample("a.exe")
    assert core.check_command([p, "--x"]) == [p, "--x"]
    with pytest.raises(ToolError):
        core.check_command([])
    with pytest.raises(ToolError):
        core.check_command([p, 3])


def test_clamps_and_pid():
    assert core.clamp_timeout(10_000) == core.MAX_TIMEOUT
    assert core.clamp_timeout(0) == 1
    with pytest.raises(ToolError):
        core.clamp_timeout("5")
    assert core.clamp_int(10**9, 1, 50, "x") == 50
    for bad in (0, -1, True, "4", 2**40):
        with pytest.raises(ToolError):
            core.check_pid(bad)
    assert core.check_pid(4) == 4


def test_decode_bytes_utf16():
    assert core.decode_bytes("hello".encode("utf-16")) == "hello"
    assert core.decode_bytes("hello world".encode("utf-16-le")) == "hello world"
    assert core.decode_bytes(b"\xef\xbb\xbfabc") == "abc"


def test_run_cmd_missing_binary(tmp_path):
    r = run_cmd([str(tmp_path / "nope.exe")], 5)
    assert r["missing_binary"] == "nope.exe" and r["exit_code"] is None


def test_run_cmd_output_cap_keeps_tail(fake):
    p = fake.make("big", "i=0; while [ $i -lt 20000 ]; do echo line$i-xxxxxxxxxxxx; i=$((i+1)); done\n"
                         "echo LASTLINE 1>&2\n")
    r = run_cmd([str(p)], 20, cap=1000)
    assert r["truncated"] is True
    assert len(r["stdout"]) <= 1000
    assert "line19999-" in r["stdout"] and "line0-" not in r["stdout"]
    assert "LASTLINE" in r["stderr"]
    head = run_cmd([str(p)], 20, cap=1000, keep="head")
    assert "line0-" in head["stdout"] and "line19999" not in head["stdout"]


def test_run_cmd_timeout_kills_process_tree(fake, tmp_path):
    marker = tmp_path / "survivor"
    p = fake.make("slow", f"(sleep 3; touch {marker}) &\nsleep 60\n")
    t0 = time.monotonic()
    r = run_cmd([str(p)], 1)
    assert r["timed_out"] and "timed out" in r["error"]
    assert time.monotonic() - t0 < 10
    time.sleep(3.5)
    assert not marker.exists(), "child of the timed-out process was not killed"


def test_run_cmd_uses_no_shell(fake):
    p = fake.make("echoargs", 'for a in "$@"; do echo "[$a]"; done\n')
    r = run_cmd([str(p), "a b", "*", "$HOME", ";id"], 10)
    assert r["stdout"].split() == ["[a", "b]", "[*]", "[$HOME]", "[;id]"]
