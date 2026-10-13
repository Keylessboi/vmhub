import os
import stat

import pytest

from winre_toolbox_mcp import tools

TOOL_NAMES = ("sigcheck", "strings", "handle", "listdlls", "procdump", "autorunsc", "procmon",
              "diec", "capa", "floss", "ilspycmd", "tshark")


@pytest.fixture
def fake(tmp_path, monkeypatch):
    """Fake Windows tools (shell scripts) wired in through the RE_TOOL_<NAME> overrides."""
    bindir = tmp_path / "fakebin"
    bindir.mkdir()
    sandbox = tmp_path / "sandbox"
    sandbox.mkdir()
    monkeypatch.setenv("RE_TOOLBOX_WORK", str(tmp_path / "work"))
    monkeypatch.setenv("RE_TOOLBOX_ROOTS", str(sandbox))
    monkeypatch.setenv("ARGLOG", str(tmp_path / "args.log"))
    for n in TOOL_NAMES:  # nothing is found unless a test creates it
        monkeypatch.setenv("RE_TOOL_" + n.upper(), str(bindir / ("absent-" + n)))

    class F:
        path = bindir
        tmp = tmp_path
        box = sandbox
        argv_log = tmp_path / "args.log"

        @staticmethod
        def make(name, body):
            p = bindir / name
            p.write_text("#!/bin/sh\n" + body.replace("@LOG@", "printf '%s\\n' \"$*\" >> \"$ARGLOG\""))
            p.chmod(p.stat().st_mode | stat.S_IXUSR)
            monkeypatch.setenv("RE_TOOL_" + name.upper(), str(p))
            return p

        @staticmethod
        def args():
            return F.argv_log.read_text().rstrip("\n").splitlines()

        @staticmethod
        def sample(name="sample.exe", data=b"MZ" + b"A" * 64):
            p = sandbox / name
            p.write_bytes(data)
            return str(p)

    tools._procmon.clear()
    yield F
    for st in list(tools._procmon.values()):
        if st["proc"].poll() is None:
            st["proc"].kill()
    tools._procmon.clear()
