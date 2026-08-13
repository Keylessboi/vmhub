#!/usr/bin/env bash
# vmhub homeserver post-install — run on the Proxmox host after first boot.
#
# Sets up, in order:
#   1. apt baseline + qemu-guest-agent
#   2. vmbr1 NAT bridge for test VMs
#   3. NAT masquerade (persisted)
#   4. vmhub storage dirs
#   5. FDE: encrypted ZFS VM-data pool on the LARGEST non-root disk
#      (the boot disk is never touched — see find_data_disk)
#   6. systemd auto-load for the pool key (no manual unlock after boot)
#   7. scoped vmhub@pve API token (prints once — capture into Doppler)
#
# Idempotent: safe to re-run. Each step checks its own state first.

set -euo pipefail

NAT_NET="10.10.10.0/24"
NAT_GW="10.10.10.1"
LAN_IF="vmbr0"            # created by the installer from the answer file
KEYS_DIR="/etc/zfs/keys"
POOL="vmhub"
DATASET="${POOL}/data"

echo "==> [1/7] apt baseline"
apt-get update -y
apt-get install -y qemu-guest-agent curl iptables-persistent netfilter-persistent ssacli

echo "==> [2/7] vmbr1 NAT bridge"
if ! grep -q "iface vmbr1" /etc/network/interfaces; then
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
  ifup vmbr1
else
  echo "   vmbr1 already configured"
fi

echo "==> [3/7] NAT masquerade"
iptables -t nat -C POSTROUTING -s ${NAT_NET} -o ${LAN_IF} -j MASQUERADE 2>/dev/null || \
  iptables -t nat -A POSTROUTING -s ${NAT_NET} -o ${LAN_IF} -j MASQUERADE
iptables -C FORWARD -i vmbr1 -o ${LAN_IF} -j ACCEPT 2>/dev/null || \
  iptables -A FORWARD -i vmbr1 -o ${LAN_IF} -j ACCEPT
iptables -C FORWARD -i ${LAN_IF} -o vmbr1 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || \
  iptables -A FORWARD -i ${LAN_IF} -o vmbr1 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
netfilter-persistent save
echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/99-vmhub.conf
sysctl -p /etc/sysctl.d/99-vmhub.conf >/dev/null

echo "==> [4/7] storage dirs"
mkdir -p /var/lib/vmhub/goldens /var/lib/vmhub/leases /var/lib/vmhub/artifacts
chmod 700 /var/lib/vmhub

echo "==> [5/7] FDE: encrypted ZFS pool on the data disk"
# Security model: every disk that leaves the server must be unreadable.
# The system disk (boot USB) is LUKS-encrypted by the installer. The VM-data
# pool below is ZFS-native-encrypted (aes-256-gcm). Its keyfile lives on the
# encrypted system disk, so both layers are bound together: without the boot
# passphrase, neither the OS nor the data pool unlocks.
mkdir -p "$KEYS_DIR"
chmod 700 "$KEYS_DIR"
if [ ! -f "$KEYS_DIR/vmhub.key" ]; then
  dd if=/dev/urandom of="$KEYS_DIR/vmhub.key" bs=32 count=1 status=none
  chmod 600 "$KEYS_DIR/vmhub.key"
fi

find_data_disk() {
  # Pick the LARGEST non-removable disk that does NOT hold the root device.
  # Containment check (lsblk -no NAME on each disk) is robust across plain
  # partitions, LVM and LUKS: it asks "which disk contains pve-root/LV/..."
  # directly, instead of trusting PKNAME chains that go empty on dm devices.
  local root_name root_disk="" largest="" name size removable
  root_name=$(basename "$(findmnt -no SOURCE /)")
  for d in /sys/block/sd*; do
    name=$(basename "$d")
    lsblk -rno NAME "/dev/$name" 2>/dev/null | grep -qx "$root_name" && root_disk="$name"
  done
  for d in /sys/block/sd*; do
    name=$(basename "$d")
    [ "$name" = "$root_disk" ] && continue
    removable=$(cat "$d/removable" 2>/dev/null || echo 0)
    [ "$removable" = "1" ] && continue            # boot USB, backup stick
    size=$(cat "$d/size" 2>/dev/null || echo 0)
    [ "$size" -lt 209715200 ] && continue         # skip < 100 GiB
    if [ -z "$largest" ] || [ "$size" -gt "$(cat /sys/block/$largest/size)" ]; then
      largest="$name"
    fi
  done
  if [ -z "$largest" ]; then
    echo "ERROR: no data disk found. Install a drive into the P420i and" >&2
    echo "       create a logical volume (ssacli ctrl slot=0 create ...)." >&2
    exit 1
  fi
  echo "/dev/$largest"
}

if ! zpool list "$POOL" >/dev/null 2>&1; then
  DATA_DISK=$(find_data_disk)
  echo "   data disk: $DATA_DISK ($(lsblk -dno SIZE,MODEL "$DATA_DISK"))"
  # Double-guard: refuse the boot disk even if detection failed.
  [ "$DATA_DISK" = "/dev/sda" ] && ! grep -q "removable.*1" /sys/block/sda/removable && {
    echo "ERROR: refusing to build pool on $DATA_DISK (looks like boot disk)." >&2
    exit 1
  }
  zpool create -o ashift=12 "$POOL" "$DATA_DISK"
  zfs create -o encryption=aes-256-gcm \
    -o keyformat=raw -o keylocation=file://${KEYS_DIR}/vmhub.key \
    -o compression=lz4 -o recordsize=16K -o xattr=sa -o atime=off \
    "$DATASET"
  zfs load-key "$DATASET"
  echo "   created encrypted pool $POOL on $DATA_DISK"
else
  echo "   pool $POOL already exists"
fi

echo "==> [6/7] auto-load key at boot"
cat > /etc/systemd/system/zfs-load-vmhub-key.service <<EOF
[Unit]
Description=Load ZFS encryption key for ${DATASET}
DefaultDependencies=no
After=systemd-udev-settle.service
Before=zfs-mount.service
Requires=systemd-udev-settle.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=/bin/sh -c 'while ! zpool list ${POOL} >/dev/null 2>&1; do sleep 1; done'
ExecStart=/usr/sbin/zfs load-key ${DATASET}
ExecStartPost=/usr/bin/zfs mount ${DATASET}

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable zfs-load-vmhub-key.service

echo "   FDE verified:"
zfs get -H -o property,value encryption,keylocation "$DATASET" | sed 's/^/   /'

echo "==> [7/7] Proxmox API token for vmhub (scoped, never root password)"
if ! pveum user list 2>/dev/null | grep -q vmhub@pve; then
  pveum user add vmhub@pve --comment "vmhub control plane"
  pveum acl modify /vms -token 'vmhub@pve!automation' -role PVEVMAdmin 2>/dev/null || true
fi
if pveum user token list vmhub@pve 2>/dev/null | grep -q automation; then
  echo "   token 'automation' already exists — do NOT rotate unless you re-capture it."
else
  pveum user token add vmhub@pve automation --privsep 1
fi
echo
echo "NOTE: if the token was just created, its secret printed above. Store it"
echo "      in Doppler (project: proxmox, config: prd) as PVE_TOKEN — shown"
echo "      once by pveum. PVE_HOST=192.168.1.220"
echo
echo "==> done. NAT is live; pool is encrypted and auto-unlocked."
