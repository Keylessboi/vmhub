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

echo "==> FDE: encrypted ZFS VM-data pool (aes-256-gcm, server-side keyfile)"
# Installer used default LVM-thin (system on NVMe). We layer ZFS native
# encryption on a dedicated VM-data pool (1TB sda, else LVM-backed). Keyfile
# lives on the unencrypted system disk — server-side, auto-loaded, no boot
# password. Pulled data drives are unreadable without it.
KEYS_DIR=/etc/zfs/keys
mkdir -p "$KEYS_DIR"
chmod 700 "$KEYS_DIR"
if [ ! -f "$KEYS_DIR/vmhub.key" ]; then
  dd if=/dev/urandom of="$KEYS_DIR/vmhub.key" bs=32 count=1 status=none
  chmod 600 "$KEYS_DIR/vmhub.key"
fi

# Prefer a dedicated 1TB disk (sda); fall back to an LVM-backed pool.
VM_DATA_POOL=""
if [ -b /dev/sda ] && [ ! -e /dev/sda1 ]; then
  if ! zpool list vmhub >/dev/null 2>&1; then
    zpool create -o ashift=12 vmhub /dev/sda
    zfs create -o encryption=aes-256-gcm \
      -o keyformat=raw -o keylocation=file://${KEYS_DIR}/vmhub.key \
      -o compression=lz4 -o recordsize=16K -o xattr=sa -o atime=off vmhub/data
    zfs load-key vmhub/data
    VM_DATA_POOL="vmhub"
    echo "   created encrypted pool vmhub on /dev/sda"
  else
    VM_DATA_POOL="vmhub"
  fi
else
  if ! zpool list vmhub >/dev/null 2>&1; then
    zpool create vmhub pve-data
    zfs create -o encryption=aes-256-gcm \
      -o keyformat=raw -o keylocation=file://${KEYS_DIR}/vmhub.key \
      -o compression=lz4 -o recordsize=16K -o xattr=sa -o atime=off vmhub/data
    zfs load-key vmhub/data
    VM_DATA_POOL="vmhub"
    echo "   created encrypted pool vmhub on pve-data"
  else
    VM_DATA_POOL="vmhub"
  fi
fi

# Auto-load the key at boot, before anything mounts the dataset.
cat > /etc/systemd/system/zfs-load-vmhub-key.service <<EOF
[Unit]
Description=Load ZFS encryption key for vmhub/data
DefaultDependencies=no
After=systemd-udev-settle.service
Before=zfs-mount.service
Requires=systemd-udev-settle.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/zfs load-key vmhub/data
ExecStartPost=/usr/bin/zfs mount vmhub/data

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable zfs-load-vmhub-key.service

echo "   FDE configured. Verify with: zfs get encryption,keylocation vmhub/data"

echo "==> Proxmox API token for vmhub (scoped, never root password)"
pveum user add vmhub@pve --comment "vmhub control plane"
pveum user token add vmhub@pve automation --privsep 1
pveum acl modify /vms -token 'vmhub@pve!automation' -role PVEVMAdmin
echo
echo "NOTE: store the token secret printed above into Doppler (project: proxmox,"
echo "      config: prd) as PVE_TOKEN. It is shown once by pveum — capture it now."
echo "      Doppler: cd ~/Projects/vmhub && doppler secrets set PVE_TOKEN=<paste>"
echo
echo "==> done. reboot or 'ifup vmbr1' to activate NAT."
