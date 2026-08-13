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

echo "==> FDE: encrypted VM-data dataset (aes-256-gcm, server-side keyfile)"
# The installer cannot encrypt. We layer ZFS native encryption on a dedicated
# dataset. The keyfile lives on the (unencrypted) system pool — on the server,
# as requested — and is auto-loaded at boot by systemd. No boot password.
# Any pulled data drive is unreadable without the keyfile.
KEYS_DIR=/etc/zfs/keys
mkdir -p "$KEYS_DIR"
chmod 700 "$KEYS_DIR"
if [ ! -f "$KEYS_DIR/vmhub.key" ]; then
  dd if=/dev/urandom of="$KEYS_DIR/vmhub.key" bs=32 count=1 status=none
  chmod 600 "$KEYS_DIR/vmhub.key"
fi

# Create the encrypted dataset if it does not exist yet.
if ! zfs list rpool/vmhub >/dev/null 2>&1; then
  zfs create \
    -o encryption=aes-256-gcm \
    -o keyformat=raw \
    -o keylocation=file://${KEYS_DIR}/vmhub.key \
    -o compression=lz4 \
    -o recordsize=16K \
    -o xattr=sa \
    -o atime=off \
    rpool/vmhub
  zfs load-key rpool/vmhub
  echo "   created encrypted rpool/vmhub (aes-256-gcm, keyfile auto-load)"
fi

# Auto-load the key at boot, before anything mounts the dataset.
cat > /etc/systemd/system/zfs-load-vmhub-key.service <<EOF
[Unit]
Description=Load ZFS encryption key for rpool/vmhub
DefaultDependencies=no
After=systemd-udev-settle.service
Before=zfs-mount.service
Requires=systemd-udev-settle.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/zfs load-key rpool/vmhub
ExecStartPost=/usr/bin/zfs mount rpool/vmhub

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable zfs-load-vmhub-key.service

echo "   FDE configured. Verify with: zfs get encryption,keylocation rpool/vmhub"

echo "==> Proxmox API token for vmhub (scoped, never root password)"
pveum user add vmhub@pve --comment "vmhub control plane"
pveum user token add vmhub@pve automation --privsep 1
pveum acl modify /vms -token 'vmhub@pve!automation' -role PVEVMAdmin
echo
echo "NOTE: store the token secret printed above into ~/.env as PVE_TOKEN"
echo "      (the secret is shown once by pveum — capture it now)."
echo
echo "==> done. reboot or 'ifup vmbr1' to activate NAT."
