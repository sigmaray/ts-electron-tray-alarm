import { app, ipcMain, IpcMain } from 'electron';
import { Alarm } from './settings';

export interface IpcDependencies {
  getAlarms(): Alarm[];
  setAlarms(alarms: Alarm[]): void;
  saveSettings(): void;
  updateTrayIcon(): void;
  sendAlarmsToRenderer(): void;
  minimizeWindow(): void;
  trayClick(): void;
  toggleCountdownWindow(): void;
  destroyCountdownWindow(): void;
  stopBlinking(): void;
  getEffectiveTimezone(): string;
  getTimezonePref(): string | null;
  setTimezonePref(timezone: string | null): void;
}

export function registerIpcHandlers(deps: IpcDependencies, handlers: IpcMain = ipcMain): void {
  handlers.on('alarm-add', (_event, alarm: Alarm) => {
    deps.setAlarms([...deps.getAlarms(), alarm]);
    deps.saveSettings();
    deps.updateTrayIcon();
    deps.sendAlarmsToRenderer();
  });
  handlers.on('alarm-update', (_event, alarm: Alarm) => {
    const current = deps.getAlarms();
    const index = current.findIndex(existing => existing.id === alarm.id);
    if (index < 0) return;
    const updated = [...current];
    updated[index] = alarm;
    deps.setAlarms(updated);
    deps.saveSettings();
    deps.updateTrayIcon();
    deps.sendAlarmsToRenderer();
  });
  handlers.on('alarm-delete', (_event, alarmId: string) => {
    deps.setAlarms(deps.getAlarms().filter(alarm => alarm.id !== alarmId));
    deps.saveSettings();
    deps.updateTrayIcon();
    deps.sendAlarmsToRenderer();
  });
  handlers.on('alarm-get-all', () => deps.sendAlarmsToRenderer());
  handlers.on('minimize-window', () => deps.minimizeWindow());
  handlers.on('tray-click', () => deps.trayClick());
  handlers.on('close-app', () => { app.isQuitting = true; app.quit(); });
  handlers.on('alarm-dismiss', () => deps.stopBlinking());
  handlers.on('countdown-window-toggle', () => deps.toggleCountdownWindow());
  handlers.on('countdown-window-close', () => deps.destroyCountdownWindow());
  handlers.handle('get-timezones', (): string[] => {
    const intl = Intl as typeof Intl & { supportedValuesOf?(key: string): string[] };
    return typeof intl.supportedValuesOf === 'function' ? intl.supportedValuesOf('timeZone') : [
      'Europe/Moscow', 'Europe/Samara', 'Europe/Volgograd', 'Europe/Kaliningrad', 'Europe/Minsk', 'Europe/Kyiv',
      'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Yekaterinburg', 'Asia/Novosibirsk',
      'Asia/Vladivostok', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Almaty', 'America/New_York',
      'America/Los_Angeles', 'America/Chicago', 'UTC',
    ];
  });
  handlers.handle('get-current-timezone', () => ({
    effective: deps.getEffectiveTimezone(), isSystem: deps.getTimezonePref() === null,
  }));
  handlers.handle('set-timezone', (_event, timezone: string | null) => {
    deps.setTimezonePref(timezone && timezone.trim() ? timezone.trim() : null);
    deps.saveSettings();
    return { effective: deps.getEffectiveTimezone(), isSystem: deps.getTimezonePref() === null };
  });
}
