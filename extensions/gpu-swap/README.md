# gpu-swap

Picking a model swaps the GPU backend it needs. Some local backends cannot hold the GPUs at the
same time, for example Strata (pi provider `strata`, about 90 s to load) and the llama.cpp router
(pi provider `llama.cpp`). With gpu-swap, picking a Strata model starts Strata. Your next request
waits until Strata answers, and the router comes back once nobody has used Strata for a while.

Off by default. Nothing is checked, started or stopped until `PI_GPU_SWAP=on` or the config file
says `"enabled": true`.

## What it does

- **Warm-up on `model_select`.** When the picked model's provider needs the other backend, the swap
  starts at once, so loading overlaps typing.
- **Wait on `before_provider_request`.** pi awaits this hook before each request. If the needed
  backend does not answer yet, gpu-swap switches (stops the holder, starts the needed one) and
  waits until its health URL answers, with a status line such as `Loading Strata… ~90 s (23 s)`.
  The request then goes out. After `readyTimeoutSeconds` it gives up: it shows an error such as
  `gpu-swap: Strata did not answer … within 300 s` and stops the turn (pi would send the request
  anyway after a hook error). A unit that stops while it loads fails at once and names the unit; a
  backend left up by a failed switch is stopped by the next switch-back. Esc stops the wait; the
  warm-up goes on. Picking another model during a warm-up cancels it.
- **Lease.** One file shared by every pi session on the machine
  (`$XDG_RUNTIME_DIR/pi-gpu-swap/lease.json`). It records which backend holds the GPUs and which pi
  processes use which backend, with heartbeats. A session's claim lasts while its heartbeat is fresh
  and it has sent a request within the idle time, or a request is still running. A session that
  needs the other backend while another live session holds a claim waits, with
  `GPUs busy: llama.cpp router in use by another pi session (pid …)` in the status line. After
  `leaseWaitSeconds` it fails with a message that names the holder. **It never takes the GPUs from
  a live session.** Entries whose heartbeat is stale or whose process is gone are dropped by the
  next session that touches the file.
- **Switch-back.** Once no live session has used the non-default backend for `idleMinutes`
  (default 10), or its last session quits, gpu-swap starts the default backend (the router) again.
  `/new`, `/resume`, `/fork` and `/reload` keep the process's claim.
- **`/gpu-swap`** shows the holder, which backends answer, the sessions in the lease and the
  settings.

## Setup

The host provides the units and the permission. gpu-swap only calls `systemctl start|stop` as your
user, never sudo:

- a systemd unit per backend, for example `strata.service` and `local-ai-router.service`. They
  should declare `Conflicts=` on each other. gpu-swap stops the holder first anyway.
- a polkit rule that lets your user start and stop exactly those units without a password.

Then turn it on and tell it where each backend answers. `~/.pi/agent/gpu-swap.json` (or
`$PI_GPU_SWAP_CONFIG`):

```json
{
  "enabled": true,
  "defaultBackend": "router",
  "backends": {
    "router": { "unit": "local-ai-router.service", "health": "http://<router-host>:<port>/health" },
    "strata": { "unit": "strata.service", "health": "http://<strata-host>:<port>/v1/models", "loadSeconds": 90 }
  },
  "providers": { "llama.cpp": "router", "strata": "strata" },
  "idleMinutes": 10
}
```

The health URL must be the backend itself, not a proxy in front of it that always answers. The
health check sends the API key of the first pi provider mapped to the backend (or of
`authProvider`), so a key-protected endpoint works without putting the key here.

| setting | default | |
|---|---|---|
| `enabled` | `false` | also `PI_GPU_SWAP=on` / `off` |
| `defaultBackend` | `router` | the backend that holds the GPUs when nobody needs another |
| `backends.<name>` | `router` (`local-ai-router.service`), `strata` (`strata.service`) | `unit`, `health`, `label`, `loadSeconds` (shown only), `authProvider`, `start` / `stop` (argument vectors, e.g. `["local-ai-mode", "strata"]`, instead of `systemctl start|stop <unit>`); `null` removes one |
| `providers.<pi provider>` | `strata` → `strata`, `llama.cpp` → `router` | providers not listed are left alone; `null` removes one |
| `readyTimeoutSeconds` | 300 | `PI_GPU_SWAP_READY_TIMEOUT` |
| `leaseWaitSeconds` | 600 | how long to wait for another session's claim; `PI_GPU_SWAP_LEASE_WAIT` |
| `idleMinutes` | 10 | `PI_GPU_SWAP_IDLE_MINUTES` |
| `heartbeatSeconds` / `staleSeconds` | 15 / 60 | |
| `leaseFile` | `$XDG_RUNTIME_DIR/pi-gpu-swap/lease.json` | `PI_GPU_SWAP_LEASE_FILE` |
| `systemctl` | `systemctl` | `PI_GPU_SWAP_SYSTEMCTL` |

`PI_GPU_SWAP_HEALTH_<BACKEND>` (e.g. `PI_GPU_SWAP_HEALTH_STRATA`) sets a backend's health URL from
the environment. No hostname or address is built in. Without a health URL, "unit active" counts as
ready, which is too early for a backend that loads for 90 s.

## Limits

- **Clients outside pi do not see the lease.** Anything that calls the router (or Strata) directly
  (curl, another app, a bench script) gets connection errors while the other backend holds the
  GPUs, and a backend started by hand is not recorded until a pi session next checks.
- Switch-back runs from a live pi session's heartbeat. If every pi session dies at once, the
  non-default backend stays up until the next pi session starts and its heartbeat sees no claim.
- Only agent-loop requests pass `before_provider_request`. A compaction or summary request does
  not, so `/compact` after the backend was switched away fails; send a prompt first.
- A model picked while a turn runs warms up after the turn: the turn keeps its backend.
- `readyTimeoutSeconds` counts from when the start command returns (`systemctl start` returns at
  once for a simple unit).
- One machine: the lease is a local file, and a process is alive if `kill(pid, 0)` says so.

## Tests

`index.test.ts` drives the swap against a fake `systemctl` (`test-fixtures/systemctl.mjs`, units
in a JSON file) and fake health endpoints (local HTTP servers that answer once their unit has been
active for its load time). It covers the swap, warm-up and wait, timeout, a unit dying while it
loads, a lease held by another session, idle and quit switch-back, and stale lease cleanup.
