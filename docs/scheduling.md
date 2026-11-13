# Agent scheduling

Prerequisites (the payload scripts assume all of these): a systemd **user**
session, `pi` at `/usr/bin/pi` (wakes exec that absolute path — symlink if
your install lives elsewhere), `python3`, and for notifications `notify-send`
plus a session D-Bus (`/run/user/<uid>/bus`). Wake output is stored in the
schedule directory's `logs/`; service failures are also reported to systemd.

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
- **Self-cleaning**: one-shot and multi-up units attempt to remove themselves
  and their sidecar after firing; recurring items persist until
  `cancel_scheduled`.
- **Wake safety**: one scheduled wake per session at a time (`flock`; busy
  wakes skip, log and exit 75), `timeout` cap (default 30 min, max 240), stale
  `node_modules/.bin` PATH entries stripped, full output under the schedule
  directory's `logs/`. The lock does not detect interactive Pi sessions or
  other processes that do not use it.
- **Calendar validation authority is systemd** — do not hand-validate
  OnCalendar grammar in code.

Wakes pass the stored session ID and prompt as separate Pi arguments and run in
the saved session cwd. A missing saved cwd fails the wake rather than selecting
a different project. Legacy entries without a cwd use the service's inherited
cwd. Pi resolves the session ID; the scheduler does not independently verify
which session Pi opens. Prompts starting with `@` are rejected because Pi can
interpret them as file arguments. NUL bytes are not supported in arguments.

A fired one-shot or multi-up unit is cleaned up after success, Pi failure,
timeout or a busy skip. Recurring units remain scheduled. Pi's exit status
(including timeout status 124) is returned; cleanup failures also fail an
otherwise successful service. Invalid sidecars fail without cleanup. Concurrent
multi-up firings can leave an orphaned sidecar; cleanup is not transactional.
Busy skips are not queued or retried and can lose a wake. There is no durable
or exactly-once delivery or acknowledgment.

The shared payload is refreshed when a new item is scheduled in that registry;
already-installed three-argument wake units remain compatible and use the
standard `~/.config/systemd/user` cleanup path. Existing custom-unit-directory
three-argument units need manual cleanup or recreation; newly created units
record that directory. No installed units or sidecars are migrated automatically.

## Managed jobs

`extensions/jobs.ts` provides `job_launch`, `job_list`, `job_status` and
`job_stop`. Launch requires a caller-generated lowercase UUID v4, a group,
argv with an absolute executable, and an absolute working directory (the
session cwd by default). Reuse the same UUID and identical inputs when
retrying a launch. A different input under the same UUID is rejected. To stop
jobs in one group, list that group and stop selected IDs individually. New
unit names include a random generation as well as the job ID, and the unit's
description is checked against the registry before a stop. This prevents
ordinary ID-only collisions, not deliberate interference by the same user.
Systemd's name-based stop does not atomically check the generation or
invocation identity: another same-user process can replace the exact unit
after the check and before the stop, causing the replacement to be stopped.
Do not use `job_stop` when a concurrent actor may replace these units. Older
registry entries retain their original ID-only unit names and are particularly
susceptible to accidental collisions.

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

The runner records a command's exit code or signal only after the service
cgroup and nested cgroups contain no other processes. A background worker can
therefore keep a job running after the foreground command exits. This requires
readable cgroup v2 membership at `/sys/fs/cgroup`; if it cannot be inspected,
the runner waits instead of reporting completion. The guarantee covers the
service cgroup, not processes that deliberately move to another service or
cgroup. A requested stop commits its intent before invoking systemd and reports
`cancelled` only after the recorded cgroup is empty or gone. An uncertain stop
may raise an error while preserving the intent, or reconcile as `interrupted`
if ownership or cleanup cannot be established. If the runner disappears or the
unit is missing or replaced before an exit is recorded, status reports
`interrupted`, not success. Status reconciles with systemd; if the manager
cannot be queried, the operation fails rather than guessing. A launch reservation is committed
before starting the unit, and the runner atomically claims execution before
spawning; retries and manual service restarts cannot start it again. A crash
after the claim but before spawn sacrifices execution rather than risking a
duplicate. Existing reservations are conservatively treated as claimed on
migration, including unfinished ones. A reservation left in `launching` is
reconciled after 30 seconds; stop may ask for a retry during this interval. Start errors can be
ambiguous and are reported in status. If the user manager stops at reboot,
incomplete jobs are reconciled as interrupted on the next query. Each recorded
terminal transition atomically creates one `terminalEvent`, returned by
`job_status` and `job_list`, with job ID, group, status and finish time. A
terminal event is not proof of success; inspect the job state and exit details.
The runner retries SQLite lock contention while it remains alive; a crash,
forced stop, non-lock database error, reboot or storage failure can still lose
an exit that was not committed. Legacy terminal records predate cgroup-aware
completion; `job_stop` attempts identity-checked cleanup of their surviving
cgroup and refuses to claim cleanup when it cannot establish the tree is gone.
Their original terminal event is retained. Duplicate status or stop requests
retain the same event. Existing terminal records are backfilled when the
registry is opened. An unexpected interruption
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
as acknowledgment of a terminal event. A future durable delivery mechanism must
persist pending events, retry bounded attempts across contention and restart,
expose failures, and require explicit acknowledgment or cancellation; its
consumer must be idempotent because execution cannot be exactly once.

## Tests

Run `npm test`. `tests/schedule-wake.test.ts` runs generated wake payloads
with an isolated home, registry and stubbed external commands; it never invokes
Pi. It checks
arguments, cwd, output, timeouts, busy skips and cleanup. The generated units
are also checked with `systemd-analyze verify`, but the test does not start
those units through a real user manager. `tests/jobs.test.ts` and
`tests/jobs-review.test.ts` use private temporary registries and real uniquely
named transient user services when a user manager is available. They do not call a model or alter scheduled
wakes. They check launch deduplication, argv,
permissions, exit and cancellation including SIGTERM-resistant descendants,
group selection, fresh-process status,
missing units, unit-name collisions, cgroup completion, service restart, SQLite
contention, interrupted cancellation, and terminal-event snapshots. The
exact-name replacement race is a known failing TODO test. The tests do not
test reboot, delivery attempts or durable completion delivery.
