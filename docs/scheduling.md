# Agent scheduling

Prerequisites (the payload scripts assume all of these): a systemd **user**
session, `pi` at `/usr/bin/pi` (wakes exec that absolute path — symlink if
your install lives elsewhere), `python3`, and for notifications `notify-send`
plus a session D-Bus (`/run/user/<uid>/bus`). Wake failures surface only in
`~/.pi/agent/schedule/logs/`.

`extensions/schedule.ts` gives agents four tools over a shared core
(`src/schedule/core.ts`): `schedule_notification` (desktop alert),
`schedule_wake` (headless `pi --session <id> --print <prompt>` resume),
`list_scheduled`, `cancel_scheduled`.

- **Backend**: durable systemd user units (`pi-notify-*` / `pi-wake-*`) with
  `Persistent=true` — survives reboot and suspend. JSON sidecar registry in
  `~/.pi/agent/schedule/` (or `PI_SCHEDULE_DIR`).
- **Schedule shapes**: `when` (ISO or relative `90s/30m/2h/1d`), `times`
  (2–8 firings), `recurring` (daily/weekly/hourly/monthly, `HH:MM`, or an
  OnCalendar spec — validated by `systemd-analyze calendar`, not by hand).
- **Self-cleaning**: one-shot units remove themselves and their sidecar
  after firing; multi-up entries clean the sidecar after the final firing;
  recurring items persist until `cancel_scheduled`.
- **Wake safety**: one wake per session at a time (`flock`; busy sessions
  skip and log), `timeout` cap (default 30 min, max 240), stale
  `node_modules/.bin` PATH entries stripped, logs under
  `~/.pi/agent/schedule/logs/`.
- **Calendar validation authority is systemd** — do not hand-validate
  OnCalendar grammar in code.

## Managed jobs

`extensions/jobs.ts` provides `job_launch`, `job_list`, `job_status` and
`job_stop`. Launch requires a caller-generated lowercase UUID v4, a group,
argv with an absolute executable, and an absolute working directory (the
session cwd by default). Reuse the same UUID and identical inputs when
retrying a launch. A different input under the same UUID is rejected. To stop
jobs in one group, list that group and stop selected IDs individually. Only
registered jobs whose systemd identity matches the registry are controlled.
This is an accidental-collision safeguard, not isolation from other processes
running as the same user.

Each command runs under a transient systemd user service, with
`KillMode=control-group`, a three-second stop timeout before systemd escalates,
and no restart policy. The runner uses direct argv
execution, not shell interpolation. Explicitly invoking a shell is possible
and makes its script the caller's responsibility. The service inherits the
systemd user manager's environment, which may differ from the Pi process.
It requires a user systemd manager, `systemd-run` with
`--expand-environment=no`, and the installed Node executable and this package
remaining available. Services are independent of Pi but are not restarted
on reboot. Logs, the SQLite registry and historical outcomes are under
`PI_JOBS_DIR` (default `~/.pi/agent/jobs`), which must be user-owned and
private. Logs and the database are private; they can contain sensitive data.
There is currently no automatic retention or cleanup.

The runner records a command's exit code or signal. A requested stop retains
history and stops the service cgroup. If the runner disappears or the unit is
missing or replaced before an exit is recorded, status reports `interrupted`,
not success. Status reconciles with systemd; if the manager cannot be queried,
the operation fails rather than guessing. A launch reservation is committed
before starting the unit, so retrying after an interrupted launch cannot start
the command again. A reservation left in `launching` is reconciled after 30
seconds; stop may ask for a retry during this interval. Start errors can be
ambiguous and are reported in status. If the user manager stops at reboot,
incomplete jobs are reconciled as interrupted on the next query. Each recorded
terminal transition atomically creates one `terminalEvent`, returned by
`job_status` and `job_list`, with job ID, group, status and finish time. A
terminal event is not proof of success; inspect the job state and exit details.
Duplicate status or stop requests retain the same event. Existing terminal
records are backfilled when the registry is opened. An unexpected interruption
is recorded only when a later status/list/stop operation reconciles it; there is
no background recovery. No process or reboot fault-injection test proves every
filesystem failure scenario.

## Completion wake limitation

Managed-job completion wakes are **not implemented**. Launch does not accept
session or prompt fields, and there is no delivery, acknowledgment, retry or
delivery-failure status. Unknown launch fields, including completion
subscriptions, are rejected. Terminal events are records only, not wake
requests or acknowledgments. Poll job status with an appropriate existing
scheduler if needed. `schedule_wake` skips busy sessions and is not a durable
completion delivery mechanism. In particular, do not treat a scheduled wake
as acknowledgment of a terminal event. Existing scheduled wake and
notification behavior is unchanged. A future durable delivery mechanism must
persist pending events, retry bounded attempts across contention and restart,
expose failures, and require explicit acknowledgment or cancellation; its
consumer must be idempotent because execution cannot be exactly once.

## Tests

Run `npm test`. `tests/jobs.test.ts` uses a temporary private registry and
real transient user services when a user manager is available. It does not
call a model or alter scheduled wakes. It checks launch deduplication, argv,
permissions, exit and cancellation including SIGTERM-resistant descendants,
group selection, fresh-process status,
missing units, unit-name collisions and terminal-event snapshots. It does not
test reboot, delivery attempts or durable completion delivery.
