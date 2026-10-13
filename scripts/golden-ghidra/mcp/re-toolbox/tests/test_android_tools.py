import os

from re_toolbox_mcp import android_tools as at

BADGING = """package: name='com.example.demo' versionCode='7' versionName='1.2.3' compileSdkVersion='34'
sdkVersion:'24'
targetSdkVersion:'34'
uses-permission: name='android.permission.INTERNET'
uses-permission: name='android.permission.CAMERA'
uses-permission-sdk-23: name='android.permission.READ_CONTACTS'
uses-feature: name='android.hardware.camera'
application-label:'Demo App'
launchable-activity: name='com.example.demo.Main'  label='Demo' icon=''
native-code: 'arm64-v8a' 'x86_64'
"""

APKSIGNER = """Verifies
Verified using v1 scheme (JAR signing): false
Verified using v2 scheme (APK Signature Scheme v2): true
Verified using v3 scheme (APK Signature Scheme v3): true
Verified using v4 scheme (APK Signature Scheme v4): false
Number of signers: 1
Signer #1 certificate DN: CN=Android Debug, O=Android, C=US
Signer #1 certificate SHA-256 digest: aabbcc
Signer #1 certificate SHA-1 digest: 112233
Signer #1 certificate MD5 digest: ffeedd
"""


def apk(tmp_path, name="a.apk"):
    p = tmp_path / name
    p.write_bytes(b"PK\x03\x04" + b"0" * 32)
    return str(p)


def test_apktool_decode(fake, tmp_path):
    fake.make("apktool", '@LOG@\nwhile [ $# -gt 0 ]; do [ "$1" = "-o" ] && o="$2"; shift; done\n'
              'mkdir -p "$o/smali"; echo "<manifest/>" > "$o/AndroidManifest.xml"; echo x > "$o/smali/A.smali"\n')
    a = apk(tmp_path)
    r = at.apktool_decode(a)
    assert r["manifest"].endswith("AndroidManifest.xml") and r["file_count"] == 2
    assert fake.args().startswith("d -f -o ") and fake.args().endswith(" " + a)
    r = at.apktool_decode(a, output_dir=str(tmp_path / "out"), decode_sources=False)
    assert " -s " in " " + fake.args() + " " and r["output_dir"] == str(tmp_path / "out")
    assert "already exists" in at.apktool_decode(a, output_dir=str(tmp_path / "out"))["error"]


def test_jadx_decompile(fake, tmp_path):
    fake.make("jadx", '@LOG@\nwhile [ $# -gt 0 ]; do [ "$1" = "-d" ] && o="$2"; shift; done\n'
              'mkdir -p "$o/sources/com/x"; echo c > "$o/sources/com/x/A.java"; echo c > "$o/sources/com/x/B.java"\n'
              'echo "ERROR - errors count: 2" >&2; exit 1\n')
    r = at.jadx_decompile(apk(tmp_path))
    assert r["java_files"] == 2 and r["errors"] == 2 and r["exit_code"] == 1
    assert r["sources_dir"].endswith("/sources")
    assert fake.args().startswith("-d ")


def test_apk_manifest_parses_badging(fake, tmp_path):
    fake.make("aapt", f'@LOG@\ncat <<\'EOF\'\n{BADGING}EOF\n')
    r = at.apk_manifest(apk(tmp_path))
    m = r["manifest"]
    assert fake.args().startswith("dump badging ")
    assert (m["package"], m["version_code"], m["version_name"]) == ("com.example.demo", "7", "1.2.3")
    assert (m["min_sdk"], m["target_sdk"], m["label"]) == ("24", "34", "Demo App")
    assert m["permissions"] == ["android.permission.CAMERA", "android.permission.INTERNET", "android.permission.READ_CONTACTS"]
    assert m["activities_launchable"] == ["com.example.demo.Main"]
    assert m["native_code"] == ["arm64-v8a", "x86_64"] and m["features"] == ["android.hardware.camera"]


def test_apk_manifest_prefers_aapt2(fake, tmp_path):
    fake.make("aapt2", '@LOG@\necho "package: name=\'a.b\' versionCode=\'1\' versionName=\'x\'"\n')
    fake.make("aapt", 'exit 9\n')
    assert at.apk_manifest(apk(tmp_path))["manifest"]["package"] == "a.b"


def test_apk_sign_info(fake, tmp_path):
    fake.make("apksigner", f'@LOG@\ncat <<\'EOF\'\n{APKSIGNER}EOF\n')
    r = at.apk_sign_info(apk(tmp_path))
    assert r["verified"] is True
    assert r["schemes"] == {"v1": False, "v2": True, "v3": True, "v4": False}
    assert r["signers"] == [{"n": "1", "dn": "CN=Android Debug, O=Android, C=US", "sha256": "aabbcc",
                             "sha1": "112233", "md5": "ffeedd"}]
    assert fake.args().startswith("verify --print-certs -v ")


def test_apk_sign_info_unsigned(fake, tmp_path):
    fake.make("apksigner", 'echo "DOES NOT VERIFY" >&2; echo "ERROR: Missing META-INF/MANIFEST.MF"; exit 1\n')
    r = at.apk_sign_info(apk(tmp_path))
    assert r["verified"] is False and r["signers"] == []


def test_missing_binaries(fake, tmp_path):
    a = apk(tmp_path)
    for fn in (at.apktool_decode, at.jadx_decompile, at.apk_manifest, at.apk_sign_info):
        assert fn(a).get("missing_binary"), fn.__name__
    assert at.adb_shell("10.0.0.1:5555", "id").get("missing_binary") == "adb"


def test_path_sandbox(fake):
    assert "outside allowed roots" in at.apk_manifest("/etc/passwd")["error"]
    assert "outside allowed roots" in at.apktool_decode("/etc/passwd")["error"]


def test_device_validation(fake):
    for bad in ("localhost", "10.0.0.1", "10.0.0.1:99999", "-s:5555", "a b:5555", "10.0.0.1:5555;id", ""):
        assert "host:port" in at.adb_shell(bad, "id")["error"], bad
    assert "host:port" in at.adb_packages(5555)["error"]


def test_adb_shell_argv(fake):
    fake.make("adb", 'echo "$*" >> "$ARGLOG"; [ "$1" = connect ] && { echo connected; exit 0; }; echo uid=0\n')
    r = at.adb_shell("10.10.10.100:5555", "id; ls /data")
    assert r["stdout"].strip() == "uid=0" and r["connect"] == "connected"
    lines = fake.argv_log.read_text().splitlines()
    assert lines == ["connect 10.10.10.100:5555", "-s 10.10.10.100:5555 shell id; ls /data"]
    assert "non-empty" in at.adb_shell("10.10.10.100:5555", "  ")["error"]


def test_adb_packages_parse(fake):
    fake.make("adb", '[ "$1" = connect ] && exit 0\n@LOG@\n'
              'echo "package:/data/app/~~x/com.a.b-1/base.apk=com.a.b"\n'
              'echo "package:/data/app/~~y/org.c.d-1/base.apk=org.c.d"\n')
    r = at.adb_packages("h:5555")
    assert fake.args() == "-s h:5555 shell pm list packages -f -3"
    assert r["packages"] == [{"package": "com.a.b", "apk": "/data/app/~~x/com.a.b-1/base.apk"},
                             {"package": "org.c.d", "apk": "/data/app/~~y/org.c.d-1/base.apk"}]
    assert [p["package"] for p in at.adb_packages("h:5555", filter="org.")["packages"]] == ["org.c.d"]
    at.adb_packages("h:5555", third_party_only=False)
    assert fake.args() == "-s h:5555 shell pm list packages -f"


def test_adb_pull_apk(fake, tmp_path):
    fake.make("adb", 'echo "$*" >> "$ARGLOG"\ncase "$*" in\n'
              ' connect*) ;;\n'
              ' *"pm path"*) echo "package:/data/app/x/split_config.apk"; echo "package:/data/app/x/base.apk";;\n'
              ' *pull*) echo apk > "$5";;\nesac\n')
    out = str(tmp_path / "pulled" / "app.apk")
    r = at.adb_pull_apk("h:5555", "com.a.b", out)
    assert r["output_exists"] and r["device_path"] == "/data/app/x/base.apk"
    assert "pull /data/app/x/base.apk " + out in fake.argv_log.read_text()
    assert "already exists" in at.adb_pull_apk("h:5555", "com.a.b", out)["error"]
    assert "package must look like" in at.adb_pull_apk("h:5555", "no spaces; rm", out + "2")["error"]


def test_adb_pull_apk_not_found(fake, tmp_path):
    fake.make("adb", 'exit 1\n')
    r = at.adb_pull_apk("h:5555", "com.no.such", str(tmp_path / "x.apk"))
    assert "not found" in r["error"]


def test_adb_install(fake, tmp_path):
    fake.make("adb", '[ "$1" = connect ] && exit 0\n@LOG@\necho Success\n')
    a = apk(tmp_path)
    r = at.adb_install("h:5555", a, grant_permissions=True)
    assert r["installed"] is True and fake.args() == f"-s h:5555 install -r -g {a}"


def test_adb_logcat_filter(fake):
    fake.make("adb", '[ "$1" = connect ] && exit 0\n@LOG@\nprintf "I/frida ok\\nD/other x\\nE/Frida boom\\n"\n')
    r = at.adb_logcat("h:5555", lines=50, filter="frida")
    assert fake.args() == "-s h:5555 logcat -d -t 50"
    assert r["matched"] == 2 and r["total_lines"] == 3 and "other" not in r["stdout"]
    assert "1..20000" in at.adb_logcat("h:5555", lines=0)["error"]
    assert os.path.exists(str(fake.path / "adb"))
