#!/bin/bash
# Give lease VMs (vmbr1, 10.10.10.0/24) outbound NAT through the host's
# uplink — idempotent, applied live and persisted in /etc/network/interfaces.
# vmhub's per-VM firewall still decides what each lease may reach
# (internet mode drops private/tailnet ranges; isolated drops everything).
#
#   ssh <host> bash -s < deploy/host-network.sh
set -euo pipefail
SUBNET=${VMHUB_GUEST_SUBNET:-10.10.10.0/24}
UPLINK=${VMHUB_UPLINK:-vmbr0}
RULE="-s $SUBNET -o $UPLINK -j MASQUERADE"
# With the PVE per-VM firewall on, guest frames cross the fwbr* firewall
# bridges under bridge netfilter first; conntrack would settle "no NAT"
# there, before the routed hop to $UPLINK. A separate conntrack zone for
# fwbr* traffic lets MASQUERADE apply (Proxmox's documented fix).
ZONE="PREROUTING -i fwbr+ -j CT --zone 1"

sysctl -qw net.ipv4.ip_forward=1
if iptables -t nat -C POSTROUTING $RULE 2>/dev/null; then
  echo "NAT rule already live"
else
  iptables -t nat -A POSTROUTING $RULE
  echo "NAT rule applied live"
fi

if iptables -t raw -C $ZONE 2>/dev/null; then
  echo "conntrack zone rule already live"
else
  iptables -t raw -I $ZONE
  echo "conntrack zone rule applied live"
fi

IF=/etc/network/interfaces
if grep -q "MASQUERADE" "$IF" && grep -q -- "-s $SUBNET" "$IF"; then
  echo "NAT rule already persisted in $IF"
else
  cp -a "$IF" "$IF.bak-$(date +%Y%m%d%H%M%S)"
  # Append the hooks right after the vmbr1 stanza's ip_forward post-up.
  awk -v up="    post-up   iptables -t nat -A POSTROUTING $RULE" \
      -v down="    post-down iptables -t nat -D POSTROUTING $RULE" '
    { print }
    /^iface vmbr1 / { in_vmbr1 = 1 }
    in_vmbr1 && /post-up echo 1 > \/proc\/sys\/net\/ipv4\/ip_forward/ { print up; print down; in_vmbr1 = 0 }
  ' "$IF" > "$IF.new"
  grep -q MASQUERADE "$IF.new" || { echo "could not find the vmbr1 ip_forward post-up line; add the rule by hand"; rm "$IF.new"; exit 1; }
  mv "$IF.new" "$IF"
  echo "NAT rule persisted in $IF"
fi
if ! grep -q -- "--zone 1" "$IF"; then
  cp -a "$IF" "$IF.bak-$(date +%Y%m%d%H%M%S)"
  awk -v up="    post-up   iptables -t raw -I $ZONE" -v down="    post-down iptables -t raw -D $ZONE" '
    { print }
    /post-up +iptables -t nat -A POSTROUTING .*MASQUERADE/ { print up; print down }
  ' "$IF" > "$IF.new" && grep -q -- "--zone 1" "$IF.new" && mv "$IF.new" "$IF" && echo "conntrack zone rule persisted in $IF"
fi
iptables -t nat -S POSTROUTING | grep -- "$SUBNET"
iptables -t raw -S PREROUTING | grep -- "fwbr"
