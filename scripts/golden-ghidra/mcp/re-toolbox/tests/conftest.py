import os
import shutil
import stat

import pytest

from re_toolbox_mcp import tools


@pytest.fixture
def fake(tmp_path, monkeypatch):
    """Isolated PATH containing only fake binaries; helper to create them."""
    bindir = tmp_path / "fakebin"
    bindir.mkdir()
    work = tmp_path / "work"
    monkeypatch.setenv("PATH", str(bindir))
    monkeypatch.setenv("RE_TOOLBOX_WORK", str(work))
    monkeypatch.setenv("ARGLOG", str(tmp_path / "args.log"))
    monkeypatch.delenv("RE_TOOLBOX_ROOTS", raising=False)
    monkeypatch.setenv("RE_PYTHON", str(bindir / "re-python"))
    for util in ("sleep", "mkdir", "cat"):
        real = shutil.which(util, path="/usr/bin:/bin")
        if real:
            os.symlink(real, bindir / util)

    class F:
        path = bindir
        tmp = tmp_path
        argv_log = tmp_path / "args.log"

        @staticmethod
        def make(name, body):
            p = bindir / name
            p.write_text("#!/bin/sh\n" + body.replace("@LOG@", "printf '%s\\n' \"$*\" > \"$ARGLOG\""))
            p.chmod(p.stat().st_mode | stat.S_IXUSR)
            return p

        @staticmethod
        def args():
            return F.argv_log.read_text().rstrip("\n")

    tools._mitm.update(proc=None, flows=None, port=None, log=None)
    yield F
    p = tools._mitm["proc"]
    if p is not None and p.poll() is None:
        p.kill()
    tools._mitm.update(proc=None, flows=None, port=None, log=None)


@pytest.fixture
def sample(tmp_path):
    p = tmp_path / "sample.bin"
    p.write_bytes(b"\x7fELF" + b"A" * 64)
    return str(p)
