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

## Full disk encryption, without a boot password

The goal: encrypt the VM data so a pulled hard drive is worthless. The key
stays on the server. No one types a password at boot.

The Proxmox installer cannot encrypt disks. We layer encryption on after
install. The post-install script does this:

1. Create a keyfile at `/etc/zfs/keys/vmhub.key`. The system pool is not
   encrypted, so this file survives reboots. It is the server-side key.
2. Create an encrypted dataset on the system pool:

   ```
   zfs create \
     -o encryption=aes-256-gcm \
     -o keyformat=raw \
     -o keylocation=file:///etc/zfs/keys/vmhub.key \
     -o compression=lz4 \
     -o recordsize=16K \
     -o xattr=sa \
     -o atime=off \
     rpool/vmhub
   ```

3. Add a systemd unit that loads the key at boot, before anything mounts the
   dataset. No password prompt.

Result:

- VM images live in `rpool/vmhub`, encrypted with AES-256-GCM.
- The keyfile lives on the system pool, on the server, as requested.
- Boot is automatic. Nothing asks for a password.
- Pull any data drive and the VM data on it is unreadable without the
  keyfile. No drilling required.

## What stays unencrypted

The system pool `rpool` holds the OS, the installer, and the keyfile. This is
a deliberate trade. Encrypting the system pool would require either a boot
password or a key that lives outside the server. You asked for neither. The
system pool holds no VM data and no user files. Its contents are public
distribution packages and configuration. The VM data, which is the thing you
would want to protect, is fully encrypted.

If that changes, the path is: put the keyfile on a small USB device, and
encrypt the system pool too. The work is done the same way, at a second
dataset or at a second pool.

## Compression settings

- `compression=lz4` on the system pool (installer default).
- `compression=lz4` on the encrypted VM dataset (post-install).

lz4 is fast enough that it costs almost nothing on a modern CPU, and it
removes the repeated blocks that clone farms produce. If CPU is plentiful and
the data is highly repetitive, `zstd` at level 3 is a stronger compressor and
still fast. Switch with:

```
zfs set compression=zstd rpool/vmhub
```

## How to verify

```
zfs get encryption,keylocation,compression rpool/vmhub
```

Expect:

```
NAME          PROPERTY      VALUE
rpool/vmhub   encryption    aes-256-gcm
rpool/vmhub   keylocation   file:///etc/zfs/keys/vmhub.key
rpool/vmhub   compression   lz4
```

## Disposal procedure

To retire a drive:

1. Stop the VMs that use it.
2. Remove the drive from the pool, or let the pool degrade.
3. Wipe the drive or throw it away. The data on it is encrypted. Without the
   keyfile, which stays on the server, the data is unreadable.

No drilling required. No shredding required. The encryption did the work.
