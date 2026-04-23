# @bixu/launchd

A swamp extension for managing macOS launchd daemons. Provides full lifecycle control (load, unload, start, stop, restart, enable, disable), observability (sync, detail, logs, diagnose, blame), plist management (inspect, validate, create, drift detection), discovery (list, scan, orphan detection), and reporting (health checks, process resource usage, startup audit, vendor grouping).

## Installation

```yaml
# .swamp.yaml
extensions:
  - name: "@bixu/launchd"
```

## Usage

Define a model in your `.swamp.yaml` to manage a specific daemon:

```yaml
models:
  - name: my-daemon
    type: "@bixu/launchd"
    globalArgs:
      label: com.example.mydaemon
      domain: gui
      plistPath: fixtures/com.example.mydaemon.plist  # optional
```

### Common operations

Sync the current state of a daemon:

```bash
swamp model method run my-daemon sync --json
```

List all running daemons matching a pattern:

```bash
swamp model method run my-daemon list --input pattern=docker --input status=running --json
```

Check health of daemons expected to be running (RunAtLoad or KeepAlive):

```bash
swamp model method run my-daemon health --json
```

Diagnose issues with a daemon (exit codes, plist validity, loaded state):

```bash
swamp model method run my-daemon diagnose --json
```

## Methods

| Category | Method | Description |
|----------|--------|-------------|
| Lifecycle | `load` | Bootstrap the daemon into launchd |
| Lifecycle | `unload` | Bootout the daemon from launchd |
| Lifecycle | `enable` | Enable the daemon (persists across reboots) |
| Lifecycle | `disable` | Disable the daemon |
| Lifecycle | `start` | Kickstart the daemon |
| Lifecycle | `stop` | Send SIGTERM to stop the daemon |
| Lifecycle | `restart` | Stop and restart the daemon |
| Observability | `sync` | Refresh stored daemon state |
| Observability | `detail` | Get program, environment, mach services |
| Observability | `blame` | Show why the daemon was started |
| Observability | `diagnose` | Check exit codes, plist validity, loaded state |
| Observability | `logs` | Fetch from macOS unified logging |
| Plist | `plistInfo` | Parse and validate the plist file |
| Plist | `createPlist` | Generate a new plist file |
| Plist | `diff` | Detect drift between plist and loaded state |
| Discovery | `list` | List daemons filtered by status and pattern |
| Discovery | `scan` | Discover all installed plist files on disk |
| Discovery | `orphans` | Find orphaned daemons |
| Discovery | `vendors` | Group daemons by software vendor |
| Reporting | `health` | Health check daemons expected to be running |
| Reporting | `processes` | Show CPU and memory usage |
| Reporting | `startup` | Audit daemons configured to start at login/boot |

## Platforms

- macOS (Apple Silicon and Intel)

## License

MIT
