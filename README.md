# Tray Alarm

A desktop alarm clock built with Electron. Alarms continue running while the app is minimized to the system tray.

## Features

- Create, edit, enable, disable, and delete alarms.
- Create alarms from a dialog or with quick reminders, then choose a one-time, daily, or hourly schedule.
- Choose a system notification or an always-on-top alarm window, with postpone controls.
- Choose from built-in alarm sounds and test them before saving.
- Choose a time zone independently of the system time zone.
- Show a floating countdown window and the next alarm countdown in the tray.
- Show each alarm's date, weekday, and relative day.
- Save alarms and preferences between launches.

## Development

Requirements: Node.js 20 or later and npm.

```sh
npm ci
npm run dev
```

The `dev` command builds the TypeScript sources and launches the Electron app. The build and launch scripts work on Windows, macOS, and Linux. To create a distributable archive for the current platform, run:

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

All packaged builds include the `portable-mode` marker and store settings beside the application resources when that directory is writable. Remove the marker from the packaged resources to use Electron's per-user `userData` directory instead. Existing settings from older app-directory locations are migrated on first launch. If the portable location is read-only, the app falls back to `userData`.

For E2E runs, `ALARM_SETTINGS_PATH` can point to an isolated settings file.
