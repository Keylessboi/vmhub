#!/usr/bin/env bash
# vmhub homeserver post-install — run on the Proxmox host after first boot.
# Sets up: vmbr1 NAT for test VMs, storage dirs, iptables persistence.
#
# Security notes:
# - The control plane (vmhub-lite) binds localhost on the DESKTOP in v1.
#   The Proxmox host only listens on the LAN for the Proxmox API (443) and
#   SSH (22) to the admin. No test-VM port is exposed to the LAN.
# - Test VMs live behind vmbr1 NAT. They reach the internet, nothing reaches
#   them from the LAN except through explicit host-forwarded ports.

set -euo pipefail

NAT_NET="10.10.10.0/24"
NAT_GW="10.10.10.1"
LAN_IF="vmbr0"            # created by the installer from the answer file

echo "==> apt update + baseline"
apt-get update -y
apt-get install -y qemu-guest-agent curl iptables-persistent netfilter-persistent

echo "==> create vmbr1 NAT bridge"
cat >> /etc/network/interfaces <<EOF

auto vmbr1
iface vmbr1 inet static
    address ${NAT_GW}
    netmask 255.255.255.0
    bridge_ports none
    bridge_stp off
    bridge_fd 0
    post-up echo 1 > /proc/sys/net/ipv4/ip_forward
EOF

echo "==> NAT masquerade (persisted via iptables-persistent)"
iptables -t nat -A POSTROUTING -s ${NAT_NET} -o ${LAN_IF} -j MASQUERADE
iptables -A FORWARD -i vmbr1 -o ${LAN_IF} -j ACCEPT
iptables -A FORWARD -i ${LAN_IF} -o vmbr1 -m state --state RELATED,ESTABLISHED -j ACCEPT
netfilter-persistent save

echo "==> kernel forwarding on boot"
echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/99-vmhub.conf
sysctl -p /etc/sysctl.d/99-vmhub.conf

echo "==> storage dirs (goldens immutable, leases/artifacts on the host)"
mkdir -p /var/lib/vmhub/goldens
mkdir -p /var/lib/vmhub/leases
mkdir -p /var/lib/vmhub/artifacts
chmod 700 /var/lib/vmhub

echo "==> Proxmox API token for vmhub (scoped, never root password)"
pveum user add vmhub@pve --comment "vmhub control plane"
pveum user token add vmhub@pve automation --privsep 1
pveum acl modify /vms -token 'vmhub@pve!automation' -role PVEVMAdmin
echo
echo "NOTE: store the token secret printed above into ~/.env as PVE_TOKEN"
echo "      (the secret is shown once by pveum — capture it now)."
echo
echo "==> done. reboot or 'ifup vmbr1' to activate NAT."
