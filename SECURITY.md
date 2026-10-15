# Security

Please report security problems privately, through GitHub's
[private vulnerability reporting](https://github.com/FreezaMotoqueiro/Dauntless-Reforged-Revival/security/advisories/new)
for this repository, not in a public issue. Say what is affected (the launcher, the gateway, the
content server, the host kit, or a Reforged patch to Mystic Paradox), how to reproduce it, and what
an attacker gains. Problems in Mystic Paradox's or Dauntless Revived's own code that are not
caused by our changes belong to those projects; we will help pass them on.

What we consider in scope, among others: an account key reaching anything but its own server and
certificate; a player reaching a host-only route or header through the gateway; the launcher
installing or running a runtime the player did not accept; plain HTTP leaving the tailnet;
secrets or keys in logs; path traversal in the content server or the host kit.

The design and its trust boundaries are described in [docs/architecture.md](docs/architecture.md).
The game runtime is native code that each host builds and players choose to accept: a malicious
host can harm players who accept their runtime, and the launcher tells players so.
