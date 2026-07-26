# Session Host architecture

dogsh splits into **Session Host** (authority) and **Faces** (thin clients).
Display ownership is a *lease* on who may write stdin / drive resize — not
where the shell lives.

```
Faces (native / Chrome / network)  --WS-->  Face gateway
                                              |
                                         Lease arbiter
                                              |
                                         Session mux
                                              |
                                    ShellBackend (pty | guest)
                                              |
                                         Session store (disk)
```

## Layers

| Layer | Module | Must not |
|---|---|---|
| Session store | `persist.ts`, host meta | Know about Chrome / ADB |
| Shell backend | `shell-backend.ts`, `session.ts`, `guest-backend.ts` | Know about display |
| Session mux | `session-mux.ts` | Own window chrome |
| Lease arbiter | `arbiter.ts` | Sleep / grant-hold delays |
| Face gateway | `index.ts` WS handlers | Own PTY lifetime |

## Hot potato

1. Quiesce lease / fence host (`hostGeneration`)
2. Export session bundle (mirrors + meta; guest checkpoints when available)
3. New host imports + fences old generation
4. Faces see `host-fenced` + optional `redirectUrl`, reconnect, snapshot

Live Mac `node-pty` does not migrate across machines. Cross-machine *process*
continuity requires the guest backend (checkpointable rootfs/webshell). Until
then, handoff moves authority + scrollback; shells restart under the restore seam.

## Remoteness

Daemon-observed non-loopback sockets only. No emulator/ADB/role fields in the host.
