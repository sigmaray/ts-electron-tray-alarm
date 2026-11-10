# Tray Alarm

Tray Alarm is a desktop alarm clock built with Electron. It stays available from the system tray, so alarms keep running when the main window is hidden or minimized.

## Features

- Create, edit, enable, disable, and delete alarms.
- Set an alarm for a specific date and time, or use a quick reminder from 5 seconds to 2 hours ahead.
- Choose a one-time, daily, or hourly schedule.
- Show an alarm as a system notification, an always-on-top alarm window, or both. Postpone alarms from the alarm window.
- Select and preview built-in alarm sounds, or choose silence.
- Use a time zone independent of the computer's system time zone.
- Show a floating countdown window and the time until the next alarm in the tray icon.
- View each alarm's date, weekday, and relative day.
- Keep alarms and preferences between launches.

## Download a release

Open the [latest release](https://github.com/sigmaray/ts-electron-tray-alarm/releases/latest), download the ZIP archive for your operating system, and extract it. Release archives are provided for Windows x64, Linux x64, and macOS (choose x64 or arm64 to match your Mac).

- **Windows:** Extract the ZIP, open the extracted folder, and run `Tray Alarm.exe`. To keep the tray icon visible, open **Settings → Personalization → Taskbar → Other system tray icons** (Windows 11) or **Select which icons appear on the taskbar** (Windows 10), then turn on Tray Alarm. If it is not listed yet, start the app first; you can also drag its icon from the hidden icons area (the **^** arrow) onto the taskbar.
- **macOS:** Extract the ZIP and open `Tray Alarm.app`. If macOS blocks the app because it was downloaded from the internet, open **System Settings → Privacy & Security** and choose **Open Anyway** for Tray Alarm.
- **Linux:** Extract the ZIP and launch the `Tray Alarm` application from the extracted folder. If it does not start, open a terminal in that folder, make the executable runnable (`chmod +x "Tray Alarm"`), then run `./Tray Alarm`.

The app can store its portable settings beside its extracted files, so keep the extracted folder in a location where you can write files. See [Settings storage](#settings-storage) for details.

## Run the app

Requirements: Node.js 20 or later and npm.

```sh
npm ci
npm run dev
```

Open the app to manage alarms. Closing or minimizing the main window leaves the app in the system tray. Use the tray menu to show the window or quit the app. Quick reminders are also available from the tray menu under **New in**.

## Build a distributable

```sh
npm run build:electron
```

The build creates a ZIP archive for the current platform in `release/`. The configured targets are Windows x64, Linux x64, and macOS x64 and arm64. If [Task](https://taskfile.dev/) is installed, equivalent commands include `task dev`, `task build`, `task typecheck`, `task test:unit`, `task test:e2e`, and `task package`.

## Checks

```sh
npm run typecheck
npm run test:unit
npm run test:e2e
```

The E2E suite launches the Electron application and may require a graphical display. CI runs it under a virtual display.

## Settings storage

Packaged builds include a `portable-mode` marker. When the directory containing that marker is writable, settings are stored beside it in `settings.json`. Remove the marker from the packaged resources to use Electron's per-user `userData` directory. If the portable directory is read-only, the app falls back to `userData`. Settings from older app-directory locations are migrated on first launch.

For E2E runs, set `ALARM_SETTINGS_PATH` to use an isolated settings file.
