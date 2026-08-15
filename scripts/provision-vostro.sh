#!/usr/bin/env bash
# vmhub node provisioning — run as root on a Proxmox host to register it as a
# managed vmhub node (reference box: Dell Vostro 3681, 192.168.1.153).
#
# Sets up, in order:
#   1. vmbr1 NAT bridge (10.10.10.0/24) for guest VMs — isolated, never bridged
#      onto the LAN. Guests get outbound net via MASQUERADE on vmbr0.
#   2. ip_forward + NAT masquerade (persisted via vmbr1 post-up + sysctl.d)
#   3. vmhub@pve API user + the two scoped tokens
#      (vmhub-automation = VM ops incl. destroy; vmhub-observe = read-only)
#   4. token-scoped ACLs — the real boundary: PVEVMAdmin(/) for automation,
#      PVEAuditor(/) for observe (observe covers nodes + storage + VM audit).
#   5. NTP sync (lease expiry is wall-clock math — all nodes must agree).
#
# Idempotent: safe to re-run. Each step checks its own state first.
#
# NOTE: when a token is created here, `pveum` prints the secret ONCE to stdout.
# Capture it into Doppler (project: proxmox, config: prd) as the node's
# <NAME>_AUTOMATION_TOKEN / <NAME>_OBSERVE_TOKEN. Never store it in git.

set -euo pipefail

NAT_NET="10.10.10.0/24"
NAT_GW="10.10.10.1"
LAN_IF="vmbr0"                 # WAN-facing bridge (created by the PVE installer)
NODE_NAME="${VMHUB_NODE_NAME:-VOSTRO}"

echo "==> [1/5] vmbr1 NAT bridge"
if ! grep -q "iface vmbr1" /etc/network/interfaces; then
  cat >> /etc/network/interfaces <<EOF

auto vmbr1
iface vmbr1 inet static
    address ${NAT_GW}
    netmask 255.255.255.0
    bridge-ports none
    bridge-stp off
    bridge-fd 0
    post-up echo 1 > /proc/sys/net/ipv4/ip_forward
    post-up iptables -t nat -C POSTROUTING -s ${NAT_NET} -o ${LAN_IF} -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s ${NAT_NET} -o ${LAN_IF} -j MASQUERADE
    post-up iptables -C FORWARD -i vmbr1 -o ${LAN_IF} -j ACCEPT 2>/dev/null || iptables -A FORWARD -i vmbr1 -o ${LAN_IF} -j ACCEPT
    post-up iptables -C FORWARD -i ${LAN_IF} -o vmbr1 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || iptables -A FORWARD -i ${LAN_IF} -o vmbr1 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
EOF
  ifup vmbr1
  echo "   vmbr1 created + brought up"
else
  echo "   vmbr1 already configured"
fi
ip link show vmbr1 >/dev/null 2>&1 || ifup vmbr1

echo "==> [2/5] ip_forward + NAT masquerade"
echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/99-vmhub.conf
sysctl -p /etc/sysctl.d/99-vmhub.conf >/dev/null
iptables -t nat -C POSTROUTING -s ${NAT_NET} -o ${LAN_IF} -j MASQUERADE 2>/dev/null || \
  iptables -t nat -A POSTROUTING -s ${NAT_NET} -o ${LAN_IF} -j MASQUERADE
iptables -C FORWARD -i vmbr1 -o ${LAN_IF} -j ACCEPT 2>/dev/null || \
  iptables -A FORWARD -i vmbr1 -o ${LAN_IF} -j ACCEPT
iptables -C FORWARD -i ${LAN_IF} -o vmbr1 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || \
  iptables -A FORWARD -i ${LAN_IF} -o vmbr1 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT

echo "==> [3/5] vmhub@pve API user + scoped tokens"
if ! pveum user list 2>/dev/null | grep -q vmhub@pve; then
  pveum user add vmhub@pve --email travis@sandstorm.chat --comment "vmhub control plane"
  echo "   user vmhub@pve created"
else
  echo "   user vmhub@pve already exists"
fi
for tok in vmhub-automation vmhub-observe; do
  if pveum user token list vmhub@pve 2>/dev/null | grep -q "$tok"; then
    echo "   token '$tok' already exists — not rotated"
  else
    echo "   creating token '$tok' — capture the secret printed below into Doppler"
    pveum user token add vmhub@pve "$tok" --privsep 1
  fi
done

echo "==> [4/5] ACLs — user backing roles + token-scoped roles"
# PVE evaluates a priv-separated token's permissions as the INTERSECTION of
# the token's own ACL roles and the owning user's ACL roles. The user therefore
# needs the union of both tokens' roles as a backing grant, and each token its
# own scoped role. Effective result:
#   vmhub-automation: PVEVMAdmin + PVEAuditor (VM ops incl. destroy + read-only)
#   vmhub-observe:    PVEAuditor            (read-only: nodes/storage/VM audit)
pveum aclmod / -user vmhub@pve -role PVEVMAdmin
pveum aclmod / -user vmhub@pve -role PVEAuditor
pveum aclmod / -token 'vmhub@pve!vmhub-automation' -role PVEVMAdmin
pveum aclmod / -token 'vmhub@pve!vmhub-automation' -role PVEAuditor
pveum aclmod / -token 'vmhub@pve!vmhub-observe' -role PVEAuditor

echo "==> [5/5] NTP"
if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" != "yes" ]; then
  timedatectl set-ntp true
  sleep 2
fi
echo "   NTPSynchronized=$(timedatectl show -p NTPSynchronized --value)"

echo
echo "==> done. Node ready. Verify with (observe token):"
echo "    curl -k -H \"Authorization: PVEAPIToken=vmhub@pve!vmhub-observe=<TOKEN>\" \\"
echo "      https://<node>:8006/api2/json/nodes"
echo "    Store secrets in Doppler (project: proxmox, config: prd) as:"
echo "      ${NODE_NAME}_AUTOMATION_TOKEN / ${NODE_NAME}_OBSERVE_TOKEN"
