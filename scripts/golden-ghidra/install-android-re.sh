#!/usr/bin/env bash
# install-android-re.sh - on-device reverse-engineering tools for the Android golden (BlissOS 13, x86_64).
#
# Runs on the PROXMOX HOST against a STAGING clone of the Android golden that is booted at 10.10.10.100
# (never the template itself - see docs/golden-builds.md, "Rebuilding a golden"). Idempotent. Needs `adb`,
# `curl`, `xz` on the host. The Android adapter's own transport is adb, so these tools are driven through
# vm_exec / vm_put_file / vm_get_file; nothing here opens a new server port except frida-server.
#
# Already on the golden (checked 2026-10-12): strace, tcpdump, sqlite3, toybox, nc, curl, logcat, dumpsys, pm, am.
# Added here:
#   frida-server   /system/bin/frida-server, started at boot by an init service, listening on 0.0.0.0:27042
#   frida-inject   /system/bin/frida-inject, injects a script with no client:  frida-inject -n <proc> -s hook.js
#   re-env         /system/bin/re-env, prints what is installed (for agents and for the verify step)
#
# Frida is pinned to the same release as the frida client in the x11-re image (17.23.3): a client and a
# server from different major lines refuse to talk.
set -euo pipefail

DEV=${DEV:-10.10.10.100:5555}
FRIDA=17.23.3
SERVER_SHA256=5413e802fc2edbbd7f933352542e517d8ecd55aacd5f403fe51d8170bfeaa9b6
INJECT_SHA256=d04ddc60cd350ae43c13344cb193733a66318245024639a7a62621da65bbfe91
BASE=https://github.com/frida/frida/releases/download/$FRIDA
CACHE=${CACHE:-/var/cache/android-re}
log() { echo "== $*"; }
A() { adb -s "$DEV" "$@" </dev/null; }   # adb shell swallows stdin, so never let it read ours
sh_() { A shell "$@"; }

mkdir -p "$CACHE"
fetch() { # name sha256
  local f=$CACHE/$1.xz
  if [ ! -f "$f" ] || ! echo "$2  $f" | sha256sum -c --quiet 2>/dev/null; then
    curl -fsSL --retry 3 -o "$f.part" "$BASE/$1-$FRIDA-android-x86_64.xz"
    echo "$2  $f.part" | sha256sum -c --quiet
    mv "$f.part" "$f"
  fi
}

log "connect (adb root)"
adb connect "$DEV" >/dev/null
A root >/dev/null 2>&1 || true
sleep 2; adb connect "$DEV" >/dev/null
[ "$(sh_ id -u | tr -d '\r')" = 0 ] || { echo "not root on $DEV"; exit 1; }
echo "  $(sh_ getprop ro.product.model | tr -d '\r') android $(sh_ getprop ro.build.version.release | tr -d '\r') $(sh_ getprop ro.product.cpu.abi | tr -d '\r')"

log "download frida $FRIDA (sha256-pinned)"
fetch frida-server "$SERVER_SHA256"
fetch frida-inject "$INJECT_SHA256"
for t in frida-server frida-inject; do xz -dkc "$CACHE/$t.xz" > "$CACHE/$t"; done

log "remount /system read-write"
A remount >/dev/null 2>&1 || true
sh_ mount -o remount,rw /system 2>/dev/null || sh_ mount -o remount,rw / 2>/dev/null || true
sh_ 'touch /system/.rwtest && rm /system/.rwtest' || { echo "/system is not writable"; exit 1; }

log "install binaries"
# A rerun on an image where frida-server already auto-started cannot overwrite the running binary ("Text file busy").
sh_ 'stop frida-server 2>/dev/null; pkill -x frida-server 2>/dev/null; true' </dev/null || true
sleep 1
for t in frida-server frida-inject; do
  A push "$CACHE/$t" "/data/local/tmp/$t" >/dev/null
  sh_ "cp /data/local/tmp/$t /system/bin/$t && chmod 755 /system/bin/$t && chown root:shell /system/bin/$t && rm /data/local/tmp/$t"
done
sh_ 'chcon u:object_r:system_file:s0 /system/bin/frida-server /system/bin/frida-inject 2>/dev/null || true'

log "frida-server init service"
cat > "$CACHE/frida-server.rc" <<'EOF'
# frida-server for reverse engineering; reachable only over the lease's own network.
service frida-server /system/bin/frida-server -l 0.0.0.0:27042
    class late_start
    user root
    group root
    seclabel u:r:su:s0
    oneshot
    disabled

# NOT `on property:sys.boot_completed=1`: on a freshly leased clone that trigger did not start the service
# (init.svc.frida-server never existed), while a manual `start` worked. `on boot` fires once per boot.
on boot
    start frida-server
EOF
A push "$CACHE/frida-server.rc" /data/local/tmp/frida-server.rc >/dev/null
sh_ 'cp /data/local/tmp/frida-server.rc /system/etc/init/frida-server.rc && chmod 644 /system/etc/init/frida-server.rc && rm /data/local/tmp/frida-server.rc'

log "re-env helper"
cat > "$CACHE/re-env" <<'EOF'
#!/system/bin/sh
# Prints the reverse-engineering tools available on this device.
for t in strace tcpdump sqlite3 toybox nc curl logcat dumpsys frida-server frida-inject; do
  p=$(command -v $t 2>/dev/null); printf '%-14s %s\n' "$t" "${p:-MISSING}"
done
echo "frida-server running: $(pidof frida-server >/dev/null && echo yes || echo no)  (tcp 27042)"
EOF
A push "$CACHE/re-env" /data/local/tmp/re-env >/dev/null
sh_ 'cp /data/local/tmp/re-env /system/bin/re-env && chmod 755 /system/bin/re-env && rm /data/local/tmp/re-env'
sync_ok=$(sh_ sync >/dev/null 2>&1; echo ok)

log "verify (start the service now; it also starts at every boot)"
sh_ 'pidof frida-server >/dev/null || start frida-server' || true
sleep 4
sh_ re-env
sh_ 'frida-server --version' | tr -d '\r' | sed 's/^/  frida-server /'
sh_ 'frida-inject --version' | tr -d '\r' | sed 's/^/  frida-inject /'
sh_ 'pidof frida-server >/dev/null' || { echo "frida-server is not running"; exit 1; }
sh_ 'ss -ltn 2>/dev/null | grep -c 27042 || netstat -ltn 2>/dev/null | grep -c 27042' | sed 's/^/  listeners on 27042: /'
log "done"
