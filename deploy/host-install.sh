#!/bin/bash
# Install vmhub-lite + vmhub-reaper ON the Proxmox host from binaries already
# copied to /root (bun --target=bun-linux-x64-baseline: the E5-2670 v2 has no
# AVX2). Secrets stay in /root/.vmhub.env, read by systemd via a drop-in
# (the units run with ProtectHome=true, so the service itself cannot read /root).
#
#   scp dist/baseline/vmhub-{lite,reaper} deploy/systemd/vmhub-{lite,reaper}.service \
#       deploy/systemd/vmhub-reaper.timer <host>:/root/
#   ssh <host> bash -s < deploy/host-install.sh
set -euo pipefail
cd /root
[ -f /root/.vmhub.env ] || { echo "missing /root/.vmhub.env (PVE_HOST, PVE_TOKEN_ID, PVE_TOKEN)"; exit 1; }
for f in vmhub-lite vmhub-reaper vmhub-lite.service vmhub-reaper.service vmhub-reaper.timer; do
  [ -f "$f" ] || { echo "missing /root/$f"; exit 1; }
done
[ -f /usr/local/bin/vmhub-lite ] && cp -a /usr/local/bin/vmhub-lite "/usr/local/bin/vmhub-lite.bak-$(date +%Y%m%d)"
install -m 0755 vmhub-lite vmhub-reaper /usr/local/bin/
install -m 0644 vmhub-lite.service vmhub-reaper.service vmhub-reaper.timer /etc/systemd/system/
rm -f vmhub-lite vmhub-reaper vmhub-lite.service vmhub-reaper.service vmhub-reaper.timer
install -d -m 0700 /srv/vmhub /srv/vmhub/leases /srv/vmhub/artifacts
for u in vmhub-lite vmhub-reaper; do
  mkdir -p "/etc/systemd/system/$u.service.d"
  printf '[Service]\nEnvironmentFile=/root/.vmhub.env\n' > "/etc/systemd/system/$u.service.d/10-env.conf"
done
systemctl daemon-reload
systemctl enable --now vmhub-lite.service vmhub-reaper.timer
systemctl restart vmhub-lite.service
sleep 3
systemctl --no-pager --lines=5 status vmhub-lite.service | head -12
curl -s -m 20 http://127.0.0.1:8787/v1/templates | python3 -c 'import json,sys; [print("template", t["id"], t["os"], t["availability"]) for t in json.load(sys.stdin)]'
