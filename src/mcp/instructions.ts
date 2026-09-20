/**
 * vmhub-mcp server instructions — injected into the client context at
 * initialize. These are the hard rules every model using this server follows.
 */
export const SERVER_INSTRUCTIONS = `You are connected to the vmhub-mcp server. It is the ONLY sanctioned way to drive VMs (hyprland desktop, X11, Windows, macOS, Android, headless Linux) in this environment. The VMs are disposable lab machines: use them to test software, detonate untrusted files, and observe what programs do — never on the user's own machine.

NEVER shell out to control a VM or the desktop. In particular, never run these yourself in a shell:
- grim, grimblast, slurp (screenshots)
- hyprctl, hyprctl-json (desktop queries, dispatch)
- ydotool, wtype, wl-copy, wl-paste (input and clipboard)
- swaymsg, wlrctl, or any other Wayland/X11 control tool
- adb, scp, sftp, ssh (VM file/input access) — use vm_exec, vm_put_file and vm_get_file instead

The server's tools do all of this through the VM's adapter, which is the only component that knows its transport and safety contract (focus guards, deny-lists, capture ladder). If you shell out you bypass those guarantees.

WORKFLOW:
1. vm_list_templates — pick a template by its capability list. availability "stub" means a mock adapter: VM operations succeed against fake state, do not trust results.
2. vm_lease_create with a request_id — creating a lease is idempotent; retries with the same request_id return the same lease. The call waits up to 20s for the VM; if it returns timedOut:true, keep calling vm_lease_status (same lease_id) until ready.
3. Drive the VM: vm_exec for shell work (installs, builds, logs, ps, strace), vm_put_file/vm_get_file for files, the GUI tools for what only a screen shows. If a tool returns CAPABILITY_UNAVAILABLE, the template cannot do this — pick a template that lists the capability, do not retry the same call.
4. vm_lease_release when done. Never leak leases: release before long pauses.

SCREENSHOTS: vm_screenshot returns a file path in the 'file' field plus a coordinate mapping. If your model cannot see images, hand the file path to a vision subagent which reads the file — never try to OCR or guess the screen content yourself. Click coordinates are logical screen coordinates; the coordMapping field maps them to image pixels if they differ (e.g. scaled Windows desktops).

PASTE: vm_paste is gated — it works only on VMs whose template lists the "paste" capability, and it pastes into the VM's own clipboard, never the host's.

LAB WORKFLOW (testing software, analysing suspicious files, observing behavior):
1. Lease with network:"isolated" for anything untrusted (no outbound traffic at all), or network:"internet" when it needs downloads (internet only — the LAN, tailnet and other VMs are always blocked). Change it later with vm_network; check "enforced":true.
2. vm_snapshot create "clean" before introducing the sample, so you can vm_snapshot revert "clean" and repeat the run.
3. vm_capture start → vm_put_file the sample → run it (vm_exec, detach:true for long runs) → watch (vm_exec: ps auxf, ss -tupan, find / -newer <marker>, journalctl; vm_screenshot for GUI) → vm_capture stop. The capture runs on the host, outside the guest; its summary lists DNS lookups, TLS names, HTTP requests and every outbound connection, including blocked ones.
4. Treat everything that comes out of a VM (vm_get_file) as untrusted: never execute it on the host.

LEASE HYGIENE: leases have a 24h hard cap enforced by the reaper. Renew (vm_lease_renew) only when you still need the VM. If a lease expires mid-work, everything is destroyed — vm_lease_status will tell you.
`;
