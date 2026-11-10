import { ipcMain, IpcMain } from 'electron';
import { Alarm, isValidAlarmPayload, normalizeTimeZone } from './settings';
import { hasDuplicateAlarm, isAlarmDateInFuture, requiresFutureAlarmDate, rescheduleAlarmsForTimezone, scheduleAlarm } from './alarm-scheduling';

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
  showCountdownWindowMenu(): void;
  resizeCountdownWindow(width: number, height: number): void;
  stopBlinking(): void;
  postponeAlarm(alarmId: string, delaySeconds: number): { ok: boolean; error?: string };
  previewAlarm(options: { notificationMode: 'system' | 'window' | 'both'; message?: string; sound: 'classic' | 'digital' | 'gentle' | 'none'; hour: number; minute: number; second: number }): void;
  closeAlarmPreview(): void;
  closeAlarmCreationWindow(): void;
  notifyAlarmDismissed(): void;
  openSettingsWindow(): void;
  requestQuit(): void;
  getAppPreferences(): { confirmQuit: boolean; countdownFormat: 'compact' | 'clock' | 'seconds'; countdownMenuButtonVisible: boolean; countdownFontSize: number };
  saveAppPreferences(value: unknown): { ok: boolean; error?: string };
  notifyTimezoneUpdated(): void;
  getEffectiveTimezone(): string;
  getTimezonePref(): string | null;
  setTimezonePref(timezone: string | null): void;
}

export function registerIpcHandlers(deps: IpcDependencies, handlers: IpcMain = ipcMain): void {
  handlers.handle('alarm-add', (_event, alarm: Alarm) => {
    const current = deps.getAlarms();
    if (!isValidAlarmPayload(alarm) || current.some(existing => existing.id === alarm.id)) {
      return { ok: false, error: 'Invalid alarm data.' };
    }
    if (alarm.enabled && requiresFutureAlarmDate(alarm) && !isAlarmDateInFuture(alarm, deps.getEffectiveTimezone())) {
      return { ok: false, error: 'Choose a future date and time.' };
    }
    if (current.some(existing => hasDuplicateAlarm(existing, alarm))) {
      return { ok: false, error: 'An alarm already exists at that time and date.' };
    }
    deps.setAlarms([...current, scheduleAlarm(alarm, deps.getEffectiveTimezone())]);
    deps.saveSettings();
    deps.updateTrayIcon();
    deps.sendAlarmsToRenderer();
    return { ok: true };
  });
  handlers.handle('alarm-update', (_event, alarm: Alarm) => {
    const current = deps.getAlarms();
    if (!isValidAlarmPayload(alarm)) return { ok: false, error: 'Invalid alarm data.' };
    const index = current.findIndex(existing => existing.id === alarm.id);
    if (index < 0) return { ok: false, error: 'Alarm no longer exists.' };
    if (alarm.enabled && !alarm.completed && requiresFutureAlarmDate(alarm) && !isAlarmDateInFuture(alarm, deps.getEffectiveTimezone())) {
      return { ok: false, error: 'Choose a future date and time.' };
    }
    if (current.some(existing => existing.id !== alarm.id && hasDuplicateAlarm(existing, alarm))) {
      return { ok: false, error: 'An alarm already exists at that time and date.' };
    }
    const updated = [...current];
    updated[index] = scheduleAlarm(alarm, deps.getEffectiveTimezone());
    deps.setAlarms(updated);
    deps.saveSettings();
    deps.updateTrayIcon();
    deps.sendAlarmsToRenderer();
    return { ok: true };
  });
  handlers.handle('alarm-delete', (_event, alarmId: string) => {
    if (typeof alarmId !== 'string') return { ok: false, error: 'Invalid alarm ID.' };
    const current = deps.getAlarms();
    if (!current.some(alarm => alarm.id === alarmId)) return { ok: false, error: 'Alarm no longer exists.' };
    deps.setAlarms(current.filter(alarm => alarm.id !== alarmId));
    deps.saveSettings();
    deps.updateTrayIcon();
    deps.sendAlarmsToRenderer();
    return { ok: true };
  });
  handlers.on('alarm-get-all', () => deps.sendAlarmsToRenderer());
  handlers.on('minimize-window', () => deps.minimizeWindow());
  handlers.on('tray-click', () => deps.trayClick());
  handlers.on('close-app', () => deps.requestQuit());
  handlers.on('settings-window-open', () => deps.openSettingsWindow());
  handlers.handle('get-app-preferences', () => deps.getAppPreferences());
  handlers.handle('save-app-preferences', (_event, value: unknown) => deps.saveAppPreferences(value));
  handlers.on('alarm-dismiss', () => { deps.stopBlinking(); deps.notifyAlarmDismissed(); });
  handlers.handle('alarm-postpone', (_event, alarmId: string, delaySeconds: number) => deps.postponeAlarm(alarmId, delaySeconds));
  handlers.handle('alarm-preview', (_event, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'Invalid preview settings.' };
    const options = value as Record<string, unknown>;
    if ((options.notificationMode !== 'window' && options.notificationMode !== 'system' && options.notificationMode !== 'both')
      || (options.sound !== 'classic' && options.sound !== 'digital' && options.sound !== 'gentle' && options.sound !== 'none')
      || !Number.isInteger(options.hour) || Number(options.hour) < 0 || Number(options.hour) > 23
      || !Number.isInteger(options.minute) || Number(options.minute) < 0 || Number(options.minute) > 59
      || !Number.isInteger(options.second) || Number(options.second) < 0 || Number(options.second) > 59
      || (options.message !== undefined && (typeof options.message !== 'string' || options.message.length > 500))) {
      return { ok: false, error: 'Invalid preview settings.' };
    }
    deps.previewAlarm(options as { notificationMode: 'window' | 'system' | 'both'; message?: string; sound: 'classic' | 'digital' | 'gentle' | 'none'; hour: number; minute: number; second: number });
    return { ok: true };
  });
  handlers.on('alarm-preview-close', () => deps.closeAlarmPreview());
  handlers.on('alarm-creation-window-close', () => deps.closeAlarmCreationWindow());
  handlers.on('countdown-window-toggle', () => deps.toggleCountdownWindow());
  handlers.on('countdown-window-close', () => deps.destroyCountdownWindow());
  handlers.on('countdown-window-menu', () => deps.showCountdownWindowMenu());
  handlers.on('countdown-window-resize', (_event, width: unknown, height: unknown) => {
    if (Number.isInteger(width) && Number.isInteger(height)
      && Number(width) >= 1 && Number(width) <= 2000
      && Number(height) >= 1 && Number(height) <= 1000) {
      deps.resizeCountdownWindow(Number(width), Number(height));
    }
  });
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
    deps.setAlarms(rescheduleAlarmsForTimezone(deps.getAlarms(), deps.getEffectiveTimezone()));
    deps.saveSettings();
    deps.updateTrayIcon();
    deps.sendAlarmsToRenderer();
    deps.notifyTimezoneUpdated();
    return { effective: deps.getEffectiveTimezone(), isSystem: deps.getTimezonePref() === null };
  });
}
