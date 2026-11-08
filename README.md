# Tray Alarm

A desktop alarm clock built with Electron. Alarms continue running while the app is minimized to the system tray.

## Features

- Create, edit, enable, disable, and delete alarms.
- Set alarms quickly for a time from 30 seconds to 2 hours ahead.
- Configure recurring alarms.
- Choose a time zone independently of the system time zone.
- Show a floating countdown window and the next alarm countdown in the tray.
- Save alarms and preferences between launches.

## Development

Requirements: Node.js 20 or later and npm.

```sh
npm ci
npm run dev
```

The `dev` command builds the TypeScript sources and launches the Electron app. To create a distributable archive for the current platform, run:

```sh
npm run build:electron
```

If [Task](https://taskfile.dev/) is installed, the equivalent commands include `task dev`, `task build`, `task typecheck`, `task test:unit`, `task test:e2e`, and `task package`.

## Tests

```sh
npm run typecheck
npm run test:unit
npm run test:e2e
```

The E2E suite launches the actual Electron application and may require a graphical display. CI runs it under a virtual display.

## Settings storage

By default, settings are stored in Electron's per-user `userData` directory. Existing settings from older app-directory locations are migrated on first launch. To opt into portable settings beside the application resources, include the `portable-mode` marker in the packaged resources. If that location is read-only, the app falls back to `userData`.

For E2E runs, `ALARM_SETTINGS_PATH` can point to an isolated settings file.
