import json
import os
import struct

import pytest

from winre_toolbox_mcp import tools


def test_path_outside_sandbox_rejected_everywhere(fake):
    for fn, kw in [(tools.sigcheck_scan, {"path": "/etc/passwd"}), (tools.strings_scan, {"path": "/etc/passwd"}),
                   (tools.diec_scan, {"path": "/etc/passwd"}), (tools.capa_scan, {"path": "/etc/passwd"}),
                   (tools.floss_scan, {"path": "/etc/passwd"}), (tools.ilspy_decompile, {"path": "/etc/passwd"}),
                   (tools.pe_info, {"path": "/etc/passwd"}), (tools.tshark_summary, {"pcap": "/etc/passwd"})]:
        r = fn(**kw)
        assert "outside allowed roots" in r["error"], fn.__name__


def test_missing_binary_is_graceful(fake):
    s = fake.sample()
    for fn, kw in [(tools.sigcheck_scan, {"path": s}), (tools.strings_scan, {"path": s}),
                   (tools.diec_scan, {"path": s}), (tools.capa_scan, {"path": s}),
                   (tools.floss_scan, {"path": s}), (tools.ilspy_decompile, {"path": s}),
                   (tools.procdump_run, {"pid": 4}), (tools.handle_list, {"pid": 4}),
                   (tools.listdlls_list, {"pid": 4}), (tools.autoruns_scan, {}),
                   (tools.procmon_capture_start, {}), (tools.procmon_capture_stop, {"pml_path": s}),
                   (tools.tshark_summary, {"pcap": s})]:
        r = fn(**kw)
        assert r.get("missing_binary"), fn.__name__
        assert r["exit_code"] is None and "error" in r


def test_sigcheck_argv_and_csv_parse(fake):
    fake.make("sigcheck", '@LOG@\n'
              "printf 'Path,Verified,Date,Publisher,SHA256\\n'\n"
              "printf '\"C:\\\\x.exe\",Signed,1:00,\"Microsoft Corporation\",ABCD\\n'\n")
    s = fake.sample()
    r = tools.sigcheck_scan(s)
    assert fake.args() == [f"-accepteula -nobanner -a -h -c {s}"]
    assert r["info"]["Verified"] == "Signed" and r["info"]["Publisher"] == "Microsoft Corporation"


def test_strings_both_kinds_and_cap(fake):
    fake.make("strings", '@LOG@\ncase "$*" in *" -u "*) echo "100:uni one"; echo "200:uni two";; '
                         '*) i=0; while [ $i -lt 50 ]; do echo "$i:ascii$i"; i=$((i+1)); done;; esac\n')
    s = fake.sample()
    r = tools.strings_scan(s, min_length=4, max_lines=10)
    assert fake.args()[0] == f"-accepteula -nobanner -a -o -n 4 {s}"
    assert fake.args()[1] == f"-accepteula -nobanner -u -o -n 4 {s}"
    assert len(r["ascii"]) == 10 and r["counts"] == {"ascii": 50, "unicode": 2}
    assert r["unicode"] == ["100:uni one", "200:uni two"] and r["truncated"] is True
    only = tools.strings_scan(s, kind="unicode")
    assert "ascii" not in only
    assert "kind must be" in tools.strings_scan(s, kind="x")["error"]


def test_diec_json_and_flags(fake):
    fake.make("diec", '@LOG@\necho \'{"detects":[{"filetype":"PE64","values":[{"name":"UPX"}]}]}\'\n')
    s = fake.sample()
    r = tools.diec_scan(s, deep=True, heuristic=True)
    assert fake.args() == [f"-j -d -r {s}"]
    assert r["detects"]["detects"][0]["values"][0]["name"] == "UPX"


CAPA_DOC = {
    "meta": {"analysis": {"format": "pe", "arch": "amd64", "os": "windows"}},
    "rules": {
        "create process": {"meta": {"namespace": "host-interaction/process/create", "scope": "basic block",
                                    "attack": [{"tactic": "Execution", "technique": "Native API",
                                                "subtechnique": "", "id": "T1106"}],
                                    "mbc": [{"objective": "Process", "behavior": "Create Process",
                                             "method": "", "id": "C0017"}]},
                           "matches": [[1, {}], [2, {}], [3, {}]]},
        "encrypt data": {"meta": {"namespace": "data-manipulation", "scope": "function", "attack": [], "mbc": []},
                         "matches": [[1, {}]]},
    },
}


def test_capa_summary(fake):
    fake.make("capa", "@LOG@\ncat <<'EOF'\n" + json.dumps(CAPA_DOC) + "\nEOF\n")
    s = fake.sample()
    r = tools.capa_scan(s, top_rules=1)
    assert fake.args() == [f"-q -j {s}"]
    sm = r["summary"]
    assert sm["rule_count"] == 2 and sm["format"] == "pe" and sm["arch"] == "amd64"
    assert sm["attack"] == {"Execution::Native API [T1106]": ["create process"]}
    assert sm["mbc"] == {"Process::Create Process [C0017]": ["create process"]}
    assert sm["top_rules"] == [{"rule": "create process", "matches": 3,
                                "namespace": "host-interaction/process/create", "scope": "basic block"}]


def test_capa_bad_json(fake):
    fake.make("capa", "echo not json\n")
    r = tools.capa_scan(fake.sample())
    assert r["summary"] is None and "could not parse" in r["error"]


def test_floss_caps_and_flags(fake):
    doc = {"strings": {"static_strings": [], "stack_strings": [{"function": 4096, "string": "s%d" % i}
                                                             for i in range(30)],
                       "decoded_strings": [{"string": "http://evil", "address": 1, "decoding_routine": 2,
                                            "extra": "dropped"}]}}
    fake.make("floss", "@LOG@\ncat <<'EOF'\n" + json.dumps(doc) + "\nEOF\n")
    s = fake.sample()
    r = tools.floss_scan(s, min_length=5, max_strings=10)
    assert fake.args() == [f"{s} -q -j -n 5 --no static"]
    assert len(r["strings"]["stack_strings"]) == 10 and r["counts"]["stack_strings"] == 30
    assert r["strings"]["decoded_strings"] == [{"string": "http://evil", "address": 1, "decoding_routine": 2}]
    assert r["truncated"] is True
    tools.floss_scan(s, include_static=True)
    assert fake.args()[-1] == f"{s} -q -j -n 6"


def test_ilspy_modes(fake, tmp_path):
    fake.make("ilspycmd", '@LOG@\ncase "$1" in -l) echo "N.Foo"; echo "N.Bar";; '
                          '-t) echo "class X {}";; -p) mkdir -p "$3"; echo cs > "$3/a.cs"; echo p > "$3/a.csproj";; esac\n')
    s = fake.sample("a.dll")
    r = tools.ilspy_decompile(s)
    assert fake.args() == [f"-l c {s}"] and r["types"] == ["N.Foo", "N.Bar"]
    r = tools.ilspy_decompile(s, mode="type", type_name="N.Foo")
    assert fake.args()[-1] == f"-t N.Foo {s}" and r["code"].strip() == "class X {}"
    out = str(fake.box / "decomp")
    r = tools.ilspy_decompile(s, mode="all", output_dir=out)
    assert fake.args()[-1] == f"-p -o {out} {s}"
    assert r["file_count"] == 2 and sorted(f["path"] for f in r["files"]) == ["a.cs", "a.csproj"]
    assert "outside allowed roots" in tools.ilspy_decompile(s, mode="all", output_dir="/etc/x")["error"]
    assert "type_name" in tools.ilspy_decompile(s, mode="type", type_name="a b; rm")["error"]
    assert "list_kinds" in tools.ilspy_decompile(s, list_kinds="z")["error"]
    assert "mode" in tools.ilspy_decompile(s, mode="x")["error"]


def test_procdump_pid_and_launch(fake):
    fake.make("procdump", '@LOG@\nfor last; do :; done\ndir=""\n'
                          'case "$*" in *" -x "*) dir=$(echo "$*" | sed "s/.* -x \\([^ ]*\\) .*/\\1/");; '
                          '*) dir=$4;; esac\ntouch "$dir/p.dmp"\n')
    r = tools.procdump_run(pid=1234)
    wd = r["output_dir"]
    assert fake.args() == [f"-accepteula -ma 1234 {wd}"]
    assert [os.path.basename(d["path"]) for d in r["dumps"]] == ["p.dmp"]
    exe = fake.sample("t.exe")
    r = tools.procdump_run(command=[exe, "--flag", "a b"], on_exception=True)
    assert fake.args()[-1] == f"-accepteula -ma -e -x {r['output_dir']} {exe} --flag a b"
    assert "exactly one" in tools.procdump_run()["error"]
    assert "exactly one" in tools.procdump_run(pid=1, command=[exe])["error"]
    assert "pid" in tools.procdump_run(pid=-3)["error"]
    assert "full path" in tools.procdump_run(command=["cmd.exe"])["error"]
    assert "outside allowed roots" in tools.procdump_run(pid=1, output_dir="/etc")["error"]


HANDLE_OUT = """
explorer.exe pid: 4321 DESKTOP\\vmhub
   10: Section       \\Sessions\\1\\Windows
   2C: File  (RW-)   C:\\Users\\vmhub\\a.txt
   3C: Key           HKLM\\SOFTWARE
"""


def test_handle_list(fake):
    fake.make("handle", "@LOG@\ncat <<'EOF'\n" + HANDLE_OUT + "EOF\n")
    r = tools.handle_list(pid=4321, all_types=True, max_entries=2)
    assert fake.args() == ["-accepteula -nobanner -u -a -p 4321"]
    assert r["total"] == 3 and len(r["handles"]) == 2
    f = r["handles"][1]
    assert (f["process"], f["pid"], f["type"], f["access"], f["name"]) == \
        ("explorer.exe", 4321, "File", "RW-", "C:\\Users\\vmhub\\a.txt")
    tools.handle_list(process_name="chrome")
    assert fake.args()[-1] == "-accepteula -nobanner -u -p chrome"
    assert "process_name" in tools.handle_list(process_name="a; b|c")["error"]
    assert "exactly one" in tools.handle_list()["error"]


DLL_OUT = """
notepad.exe pid: 777
Command line: "C:\\Windows\\notepad.exe"

  Base                Size      Version         Path
  0x00007ff6a0000000  0x7c000   11.0.22621.1    C:\\Windows\\System32\\notepad.exe
  0x00007ffb10000000  0x1f0000                  C:\\Windows\\System32\\ntdll.dll
"""


def test_listdlls(fake):
    fake.make("listdlls", "@LOG@\ncat <<'EOF'\n" + DLL_OUT + "EOF\n")
    r = tools.listdlls_list(777)
    assert fake.args() == ["-accepteula 777"]
    assert r["total"] == 2
    assert r["modules"][0]["version"] == "11.0.22621.1" and r["modules"][0]["path"].endswith("notepad.exe")
    assert r["modules"][1]["version"] is None and r["modules"][1]["pid"] == 777
    assert "pid" in tools.listdlls_list(0)["error"]


def test_autoruns(fake):
    rows = "Time,Entry Location,Entry,Enabled,Category,Description\n" + "\n".join(
        f"t,HKLM\\Run,e{i},enabled,{'Logon' if i % 2 else 'Services'},d" for i in range(10))
    fake.make("autorunsc", "@LOG@\ncat <<'EOF'\n" + rows + "\nEOF\n")
    r = tools.autoruns_scan(verify_signatures=True, hide_microsoft=True, max_rows=3)
    assert fake.args() == ["-accepteula -nobanner -a * -c -h -s -m"]
    assert r["total"] == 10 and len(r["rows"]) == 3 and r["truncated"] is True
    assert r["counts"] == {"Services": 5, "Logon": 5}


PROCMON_CSV = '''"Time of Day","Process Name","PID","Operation","Path","Result","Detail"
"1:00:00","evil.exe","100","CreateFile","C:\\x\\a.txt","SUCCESS","Desired Access: Generic Write"
"1:00:01","evil.exe","100","ReadFile","C:\\x\\a.txt","SUCCESS",""
"1:00:02","evil.exe","100","RegSetValue","HKCU\\Software\\Run\\evil","SUCCESS","Type: REG_SZ"
"1:00:03","evil.exe","100","TCP Connect","10.0.0.1:443","SUCCESS",""
"1:00:04","svchost.exe","900","RegQueryKey","HKLM\\x","SUCCESS",""
'''


def make_procmon(fake):
    fake.make("procmon", '@LOG@\n'
              'case "$*" in\n'
              '  */Terminate*) touch "$TERMFILE";;\n'
              '  */OpenLog*) cat > "$7" <<\'EOF\'\n' + PROCMON_CSV + 'EOF\n;;\n'
              '  */BackingFile*) touch "$5"; while [ ! -f "$TERMFILE" ]; do sleep 0.1; done;;\n'
              'esac\n')


def test_procmon_start_stop_summary(fake, monkeypatch):
    monkeypatch.setenv("TERMFILE", str(fake.tmp / "term"))
    make_procmon(fake)
    st = tools.procmon_capture_start()
    assert st["exit_code"] == 0 and st["pml"].endswith("capture.pml")
    assert fake.args() == [f"/AcceptEula /Quiet /Minimized /BackingFile {st['pml']}"]
    assert "still running" in tools.procmon_capture_start()["error"]
    r = tools.procmon_capture_stop(st["capture_id"], max_rows=10)
    assert fake.args()[1] == "/AcceptEula /Terminate"
    assert fake.args()[2] == f"/AcceptEula /Quiet /Minimized /OpenLog {st['pml']} /SaveAs {r['csv']}"
    sm = r["summary"]
    assert sm["events_total"] == 5
    assert sm["by_category"] == {"file": 2, "registry": 2, "network": 1}
    assert list(sm["top_processes"][0]) == ["evil.exe", 4]
    ops = [row["Operation"] for row in sm["rows"]]
    assert ops == ["CreateFile", "RegSetValue", "TCP Connect"]
    assert tools._procmon == {}


def test_procmon_filters_and_row_cap(fake, monkeypatch):
    monkeypatch.setenv("TERMFILE", str(fake.tmp / "term"))
    make_procmon(fake)
    st = tools.procmon_capture_start()
    r = tools.procmon_capture_stop(st["capture_id"], max_rows=1, process="evil", categories=["file", "registry"])
    sm = r["summary"]
    assert sm["events_matched"] == 4 and len(sm["rows"]) == 1
    assert "categories" in tools.procmon_capture_stop(categories=["bogus"])["error"]
    assert "no such capture" in tools.procmon_capture_stop()["error"]


def test_procmon_stop_existing_pml(fake, monkeypatch):
    monkeypatch.setenv("TERMFILE", str(fake.tmp / "term"))
    make_procmon(fake)
    pml = fake.box / "old.pml"
    pml.write_bytes(b"PML")
    r = tools.procmon_capture_stop(pml_path=str(pml), path_contains="a.txt")
    assert r["summary"]["events_matched"] == 2


def test_procmon_exits_immediately(fake):
    fake.make("procmon", "exit 3\n")
    r = tools.procmon_capture_start()
    assert "exited immediately" in r["error"]


def test_tshark_summary(fake):
    fake.make("tshark", '@LOG@\ncase "$*" in *conv,tcp*) echo "TCP Conversations";; *io,phs*) echo "Protocol Hierarchy";; '
                        '*conv,udp*) echo UDPC;; esac\n')
    pcap = fake.sample("a.pcap")
    r = tools.tshark_summary(pcap, extra_stats=["udp"])
    assert fake.args() == [f"-r {pcap} -q -z conv,tcp", f"-r {pcap} -q -z io,phs", f"-r {pcap} -q -z conv,udp"]
    assert "TCP Conversations" in r["tcp_conversations"] and "Protocol" in r["protocol_hierarchy"]
    assert r["udp_conversations"].strip() == "UDPC"
    assert "extra_stats" in tools.tshark_summary(pcap, extra_stats=["x"])["error"]


def test_tshark_output_cap_keeps_head(fake):
    fake.make("tshark", "echo HEADER; i=0; while [ $i -lt 20000 ]; do echo row$i-xxxxxxxxxxxxxxxxxxxx; i=$((i+1)); done\n")
    r = tools.tshark_summary(fake.sample("a.pcap"))
    assert r["truncated"] is True and r["tcp_conversations"].startswith("HEADER")
    assert len(r["tcp_conversations"]) <= 64 * 1024


def minimal_pe(timestamp=1700000000) -> bytes:
    """A tiny PE32+ with one .text section and no imports."""
    dos = b"MZ" + b"\x00" * 58 + struct.pack("<I", 0x40)
    coff = struct.pack("<HHIIIHH", 0x8664, 1, timestamp, 0, 0, 0xF0, 0x0022)
    opt = struct.pack("<HBBIIIIIQIIHHHHHHIIIIHHQQQQII", 0x20B, 14, 0, 0x200, 0, 0, 0x1000, 0x1000,
                      0x140000000, 0x1000, 0x200, 6, 0, 0, 0, 6, 0, 0, 0x2000, 0x200, 0, 3, 0x8160,
                      0x100000, 0x1000, 0x100000, 0x1000, 0, 16)
    opt += b"\x00" * (16 * 8)
    sect = b".text\x00\x00\x00" + struct.pack("<IIIIIIHHI", 0x100, 0x1000, 0x200, 0x200, 0, 0, 0, 0, 0x60000020)
    hdr = dos + b"PE\x00\x00" + coff + opt + sect
    hdr += b"\x00" * (0x200 - len(hdr))
    return hdr + bytes(range(256)) * 2


def test_pe_info(fake):
    pytest.importorskip("pefile")
    r = tools.pe_info(fake.sample("m.exe", minimal_pe()))
    assert r["exit_code"] == 0, r
    assert r["machine"] == "IMAGE_FILE_MACHINE_AMD64" and r["is_64bit"] is True
    assert r["timestamp_utc"] == "2023-11-14T22:13:20Z"
    assert r["sections"][0]["name"] == ".text" and r["sections"][0]["flags"] == "RX"
    assert r["sections"][0]["entropy"] == 8.0
    assert r["imports"] == [] and r["exports"] == [] and r["is_dotnet"] is False


def test_pe_info_not_a_pe(fake):
    pytest.importorskip("pefile")
    r = tools.pe_info(fake.sample("junk.bin", b"hello"))
    assert "not a valid PE" in r["error"]


def test_tool_versions(fake):
    fake.make("diec", 'echo "die 3.21"\n')
    fake.make("sigcheck", 'echo "Sigcheck v2.90 - File version and signature viewer"\nexit 1\n')
    fake.make("procmon", "touch %s\n" % (fake.tmp / "procmon-ran"))
    r = tools.tool_versions()
    t = r["tools"]
    assert t["diec"]["found"] and t["diec"]["version"] == "die 3.21"
    assert t["sigcheck"]["version"].startswith("Sigcheck v2.90")
    assert t["capa"] == {"found": False}
    assert t["procmon"]["found"] and t["procmon"]["version"] is None
    assert not (fake.tmp / "procmon-ran").exists(), "procmon must never be executed by tool_versions"
