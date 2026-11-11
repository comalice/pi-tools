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
