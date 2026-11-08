import { app, ipcMain, IpcMain } from 'electron';
import { Alarm, isValidAlarmPayload, normalizeTimeZone } from './settings';
import { alarmTimeHasPassedToday, localDateTimeInTimezone, nextAlarmTimestamp, zonedDateTimeToTimestamp } from './time.js';

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
    const current = deps.getAlarms();
    if (!isValidAlarmPayload(alarm) || current.some(existing => existing.id === alarm.id)) return;
    if (current.some(existing => existing.hour === alarm.hour && existing.minute === alarm.minute && existing.second === alarm.second)) return;
    deps.setAlarms([...current, scheduleAlarm(alarm, deps)]);
    deps.saveSettings();
    deps.updateTrayIcon();
    deps.sendAlarmsToRenderer();
  });
  handlers.on('alarm-update', (_event, alarm: Alarm) => {
    const current = deps.getAlarms();
    if (!isValidAlarmPayload(alarm)) return;
    const index = current.findIndex(existing => existing.id === alarm.id);
    if (index < 0) return;
    if (current.some(existing => existing.id !== alarm.id && existing.hour === alarm.hour && existing.minute === alarm.minute && existing.second === alarm.second)) return;
    const updated = [...current];
    updated[index] = scheduleAlarm(alarm, deps);
    deps.setAlarms(updated);
    deps.saveSettings();
    deps.updateTrayIcon();
    deps.sendAlarmsToRenderer();
  });
  handlers.on('alarm-delete', (_event, alarmId: string) => {
    if (typeof alarmId !== 'string') return;
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
    if (timezone !== null && typeof timezone !== 'string') throw new TypeError('Time zone must be a string or null');
    const normalized = normalizeTimeZone(timezone);
    if (timezone !== null && timezone.trim() !== '' && normalized === null) throw new RangeError('Unknown time zone');
    deps.setTimezonePref(normalized);
    deps.saveSettings();
    return { effective: deps.getEffectiveTimezone(), isSystem: deps.getTimezonePref() === null };
  });
}

function scheduleAlarm(alarm: Alarm, deps: IpcDependencies): Alarm {
  const scheduled = { ...alarm };
  if (!scheduled.enabled) {
    delete scheduled.scheduledAt;
  } else if (scheduled.scheduledAt === undefined && scheduled.scheduledDate) {
    const [year, month, day] = scheduled.scheduledDate.split('-').map(Number);
    const target = zonedDateTimeToTimestamp(deps.getEffectiveTimezone(), {
      year, month, day, hour: scheduled.hour, minute: scheduled.minute, second: scheduled.second,
    });
    if (target > Date.now()) {
      scheduled.scheduledAt = target;
    } else {
      scheduled.scheduledAt = nextAlarmTimestamp(deps.getEffectiveTimezone(), scheduled, Date.now());
      const next = localDateTimeInTimezone(deps.getEffectiveTimezone(), scheduled.scheduledAt);
      scheduled.scheduledDate = `${next.year}-${String(next.month).padStart(2, '0')}-${String(next.day).padStart(2, '0')}`;
    }
  } else if (scheduled.scheduledAt === undefined
    && alarmTimeHasPassedToday(deps.getEffectiveTimezone(), scheduled, Date.now())) {
    scheduled.scheduledAt = nextAlarmTimestamp(deps.getEffectiveTimezone(), scheduled, Date.now());
  }
  return scheduled;
}
