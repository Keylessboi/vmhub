# vmhub — storage and encryption

## The decision: ZFS, not btrfs

The server stores many VMs. Most VMs come from the same base image. That is a
lot of repeated data. Two tools solve this: linked clones and compression.

**Linked clones do the real work.** A linked clone shares its base image with
every other clone. One base image, ten clones, one copy of the base. This is
the single largest saving on a VM server. ZFS does linked clones natively.

**Compression does the rest.** A base image and its clones contain repeated
blocks. Compression removes those. ZFS compresses with lz4 by default.

**btrfs also compresses.** Its zstd compression is good. But btrfs has no
native encryption. To encrypt a btrfs volume you must put LUKS under it, and
then you lose the snapshot and clone semantics that make btrfs useful here.

ZFS has native encryption. So the choice is simple:

- ZFS gives linked clones, lz4 compression, and native encryption.
- btrfs gives compression only, and needs LUKS for encryption.

The repetition problem needs linked clones and compression. The disposal
problem needs encryption. Only ZFS gives all three.

## Where the data lives

This server (DL360p Gen8, `192.168.1.220`) has **no internal disk**. The OS
runs from a 119.5G USB flash drive (`/dev/sda`, removable), in the installer's
default LVM-thin layout. The P420i RAID controller has zero physical drives
and all six AHCI ports are empty. Verify with:

```
lsblk -d -o NAME,SIZE,MODEL,TRAN
ssacli ctrl slot=0 pd all show
```

The VM-data pool is built on the **largest non-root, non-removable disk**
(see `bootstrap/post-install.sh`, `find_data_disk`). The post-install script
refuses to build a pool on the boot USB: it skips the disk that holds `/` and
skips all removable devices. When a drive is installed into the P420i, create
a logical volume first so the OS sees it:

```
ssacli ctrl slot=0 pd all show
ssacli ctrl slot=0 create type=ld drives=<list> raid=0
```

Then re-run `post-install.sh`. It finds the disk, creates the encrypted pool
`vmhub` with dataset `vmhub/data`, and wires the auto-unlock unit.

## Full disk encryption for VM data

The goal: encrypt the VM data so a pulled drive is worthless. The key stays
on the server. No one types a password at boot.

The post-install script does this:

1. Create a keyfile at `/etc/zfs/keys/vmhub.key`. The system disk is not
   encrypted, so this file survives reboots. It is the server-side key.
2. Create an encrypted ZFS pool on the data disk:

   ```
   zpool create -o ashift=12 vmhub /dev/sdX
   zfs create \
     -o encryption=aes-256-gcm \
     -o keyformat=raw \
     -o keylocation=file:///etc/zfs/keys/vmhub.key \
     -o compression=lz4 \
     -o recordsize=16K \
     -o xattr=sa \
     -o atime=off \
     vmhub/data
   ```

3. Add a systemd unit (`zfs-load-vmhub-key.service`) that loads the key at
   boot, before anything mounts the dataset. No password prompt.

Result:

- VM images live in `vmhub/data`, encrypted with AES-256-GCM.
- The keyfile lives on the system disk, on the server, as requested.
- Boot is automatic. Nothing asks for a password.
- Pull the data drive and the VM data on it is unreadable without the
  keyfile. No drilling required.

## What stays unencrypted — and the honest limit of this design

The system disk holds the OS and the keyfile. This is a deliberate trade.
Encrypting the system disk would require a boot password (the Gen8 has no
TPM for auto-unlock), which changes every reboot into a manual step.

State the limit plainly:

- **Steal the data drive alone → nothing readable.** The encrypted pool
  needs the keyfile, and the keyfile is on the server.
- **Steal the boot USB and the data drive together → the pool decrypts.**
  The keyfile rides on the system disk, and the system disk is plaintext.

The second case needs physical access to remove two drives from a server
that is bolted and locked in place. That is the accepted boundary. If the
threat model tightens, the path forward is: encrypt the system disk too
(LVM+LUKS at install time, boot passphrase), or move the keyfile to a small
USB that is removed after boot. Both changes are documented in the RUNBOOK.

## Compression settings

- `compression=lz4` on the VM data pool (post-install).

lz4 is fast enough that it costs almost nothing on a modern CPU, and it
removes the repeated blocks that clone farms produce. If CPU is plentiful and
the data is highly repetitive, `zstd` at level 3 is a stronger compressor and
still fast. Switch with:

```
zfs set compression=zstd vmhub/data
```

## How to verify

```
zfs get encryption,keylocation,compression vmhub/data
```

Expect:

```
NAME          PROPERTY      VALUE
vmhub/data    encryption    aes-256-gcm
vmhub/data    keylocation   file:///etc/zfs/keys/vmhub.key
vmhub/data    compression   lz4
```

## Disposal procedure

To retire a data drive:

1. Stop the VMs that use it.
2. Remove the drive from the pool, or let the pool degrade.
3. Wipe the drive or throw it away. The data on it is encrypted. Without the
   keyfile, which stays on the server, the data is unreadable.

No drilling required. No shredding required. The encryption did the work.
