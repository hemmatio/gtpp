# GOTracker++

A self-hosted GO Transit live departure board, customizable background notifier, iOS-ready PWA, Union Station platform predictor, and delay/estimation analytics tracker powered by `gotracker.ca` JSON endpoints and SQLite.

## Features

- **Live Commute Board (SSE)**: Continuously polls `gotracker.ca` in the background (`20s` active / `45s` idle) and pushes instant updates to connected browsers via Server-Sent Events (`/api/stream`), with tap-to-expand stop-by-stop timelines.
- **Pre-Announcement Union Platform Predictions**: Shows historical platform estimates (`Est. <track>` + confidence %) directly on Board cards before Union officially posts the track, plus an interactive **Union Platform Predictor** in the Analytics tab (pick a scheduled departure or snap any time to the nearest valid train).
- **Cookie-Backed Multi-User Profiles**: Each browser/device gets an isolated profile (`gtpp_session` cookie) with its own commute route, time-window rules, push subscriptions, and Shortcuts webhook tokens—plus 6-character pairing codes to sync Safari, iOS Home Screen PWAs, and desktop browsers (schema ready for email/OAuth accounts).
- **Custom Direction & Time-Window Alerts**: Define weekday/weekend hour ranges per direction (`Home → Dest` or `Dest → Home`), plus triggers for platform announcements/changes, boarding (`Proceed`), delays, short trains, and cancellations.
- **Zero-Fee iOS Notifications**: Supports native iOS Web Push (`RFC 8291`/`8292` VAPID over HTTPS + Home Screen PWA), `ntfy.sh`, and custom webhooks.
- **Location Awareness**: Foreground GPS auto-detect inside the PWA plus private iOS Shortcuts webhooks for background Arrive/Leave geofencing.
- **Delay & Misleading-Estimation Analytics**: Tracks ground-truth outcomes vs. live predictions across `T-30m`, `T-15m`, `T-10m`, and `T-5m` (MAE, underestimation bias, and *Phantom On-Time %*), platform announcement lead times, worst offender trains, interactive `?` metric tooltips + Metrics Guide, and CSV/JSON exports.

## Architecture

- `server.py` — `aiohttp` HTTP + SSE server, cookie session middleware, static PWA host, pure-Python PNG icon generator.
- `poller.py` — Multi-user deduplicated background poller, rule evaluator, state-diff event detector, and outcome collector.
- `gotracker_client.py` — Async client for `gotracker.ca/gotracker/mobile/proxy/web/` (`utf-8-sig` BOM handling + PINS station mappings).
- `analytics.py` — Delay KPIs, prediction-drift analysis, historical platform predictor, and CSV/JSON export.
- `webpush.py` — Zero-dependency VAPID JWT + `aes128gcm` Web Push, `ntfy.sh`, and webhook dispatcher (`cryptography`).
- `db.py` — SQLite WAL persistence (`users`, `sessions`, `user_settings`, `push_subscriptions`, `live_departures`, `trip_snapshots`, `trip_outcomes`, `events`).
- `static/` — Vanilla HTML/CSS/JS iOS PWA with bundled Lucide SVG icons (`static/icons.svg`, ISC License).

## Quick Start

Requires Python 3.11+ with `aiohttp` and `cryptography`.

```bash
./gotracker.sh start
./gotracker.sh status
```

CLI subcommands:
- `./gotracker.sh` — Interactive management menu
- `./gotracker.sh start` (`1`) — Launch server in detached `tmux` session `gotracker-pp` (port `29843`, auto-restart loop)
- `./gotracker.sh kill` (`2`) — Stop server & `tmux` session
- `./gotracker.sh logs` (`3`) — Inspect/follow `server.log` or attach to `tmux`
- `./gotracker.sh open` (`4`) — Show direct / SSH tunnel URLs
- `./gotracker.sh restart` (`5`) — Restart daemon
- `./gotracker.sh cron` — Print the crontab health-check entry

## Watchdog Cronjob

```cron
*/15 * * * * curl -s -f --max-time 5 http://127.0.0.1:29843/api/health >/dev/null || (/path/to/gotracker++/gotracker.sh kill >/dev/null 2>&1; /path/to/gotracker++/gotracker.sh start >/dev/null 2>&1)
```

## iOS Setup

1. Open your HTTPS URL (e.g. `https://gtpp.omidhemmati.com/`) in **Safari** → tap **Share → Add to Home Screen**.
2. Open the installed **GOTracker++** app → **Alerts → Push Channels → Enable Web Push** (or configure **ntfy.sh**), then tap **Send Test**.
3. *(Optional)* In Apple **Shortcuts → Automation → Arrive / Leave**, set **Run Immediately** with **Get Contents of URL** pointing to the private webhook URLs shown under **Alerts → Background Location**.

## Attribution & License

- Icons sourced from [Lucide](https://lucide.dev) (`lucide-static`, ISC License).
- Licensed under the [MIT License](LICENSE).
