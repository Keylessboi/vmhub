/**
 * macOS guest SSH channel — argv construction for the exec/scp/git tools.
 *
 * The macOS golden (sequoia-15.7.9) creates a `vmhub` admin user (probe
 * report) unlike the Linux goldens' root. The SSH user split matters: the
 * ProxyJump through the Proxmox host keeps the shared user (root), while the
 * guest target uses the macOS user. Everything is argv-only — never a shell
 * string — so the channel is mock-testable without a live guest.
 */
import type { Vm } from '../../src/shared/types.ts';
import { sshJumpTarget } from '../transport.ts';

/** SSH user for the macOS guest — VMHUB_MACOS_SSH_USER, else the shared user, else vmhub. */
export function macosSshUser(env: NodeJS.ProcessEnv = process.env): string {
  return env.VMHUB_MACOS_SSH_USER ?? env.VMHUB_SSH_USER ?? 'vmhub';
}

/** ssh argv into the macOS guest (shared jump user, macos target user). */
export function macosSshArgs(vm: Vm, env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    '-T',
    '-o', 'StrictHostKeyChecking=no',
    '-o', `ProxyJump=${sshJumpTarget(env)}`,
    `${macosSshUser(env)}@${vm.ip ?? ''}`,
  ];
}

/** scp argv: put (host→guest) or get (guest→host), ProxyJump like ssh. */
export function scpIntoMacosArgs(
  vm: Vm,
  localPath: string,
  remotePath: string,
  direction: 'put' | 'get',
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const opts = ['-o', 'StrictHostKeyChecking=no', '-o', `ProxyJump=${sshJumpTarget(env)}`];
  const target = `${macosSshUser(env)}@${vm.ip ?? ''}:${remotePath}`;
  return direction === 'put' ? [...opts, localPath, target] : [...opts, target, localPath];
}

/** ssh git clone argv into the guest (ssh argv + `git clone -- <url> <dest>`). */
export function gitCloneIntoMacosArgs(vm: Vm, repoUrl: string, destPath: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return [...macosSshArgs(vm, env), 'git', 'clone', '--', repoUrl, destPath];
}
