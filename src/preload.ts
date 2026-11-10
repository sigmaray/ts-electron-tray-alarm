import { contextBridge, ipcRenderer } from 'electron';

// Alarm type
export interface Alarm {
  id: string;
  hour: number;
  minute: number;
  second: number;
  enabled: boolean;
  recurring: boolean;
  frequency?: 'once' | 'daily' | 'hourly';
  notificationMode?: 'system' | 'window' | 'both';
  postponeMinutes?: number;
  sound?: 'classic' | 'digital' | 'gentle' | 'none';
  scheduledAt?: number;
  scheduledDate?: string;
  dateExplicit?: boolean;
  message?: string;
  completed?: boolean;
}

export interface AlarmOperationResult {
  ok: boolean;
  error?: string;
}

// Expose a safe API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  minimizeWindow: () => {
    ipcRenderer.send('minimize-window');
  },
  clickTray: () => {
    ipcRenderer.send('tray-click');
  },
  closeApp: () => {
    ipcRenderer.send('close-app');
  },
  openSettingsWindow: () => ipcRenderer.send('settings-window-open'),
  getAppPreferences: () => ipcRenderer.invoke('get-app-preferences') as Promise<{
    confirmQuit: boolean;
    countdownFormat: 'compact' | 'clock' | 'seconds';
    countdownMenuButtonVisible: boolean;
    countdownFontSize: number;
  }>,
  saveAppPreferences: (preferences: {
    confirmQuit: boolean;
    countdownFormat: 'compact' | 'clock' | 'seconds';
    countdownMenuButtonVisible: boolean;
    countdownFontSize: number;
  }) =>
    ipcRenderer.invoke('save-app-preferences', preferences) as Promise<{ ok: boolean; error?: string }>,
  // Alarm commands
  addAlarm: (alarm: Alarm) => ipcRenderer.invoke('alarm-add', alarm) as Promise<AlarmOperationResult>,
  updateAlarm: (alarm: Alarm) => ipcRenderer.invoke('alarm-update', alarm) as Promise<AlarmOperationResult>,
  deleteAlarm: (alarmId: string) => ipcRenderer.invoke('alarm-delete', alarmId) as Promise<AlarmOperationResult>,
  getAllAlarms: () => {
    ipcRenderer.send('alarm-get-all');
  },
  dismissAlarm: () => {
    ipcRenderer.send('alarm-dismiss');
  },
  postponeAlarm: (alarmId: string, minutes: number) => ipcRenderer.invoke('alarm-postpone', alarmId, minutes) as Promise<AlarmOperationResult>,
  // Event listeners for messages from the main process
  onAlarmsUpdated: (callback: (alarms: Alarm[]) => void) => {
    ipcRenderer.on('alarms-updated', (_event, alarms) => callback(alarms));
  },
  onAlarmTriggered: (callback: (alarmId: string) => void) => {
    ipcRenderer.on('alarm-triggered', (_event, alarmId) => callback(alarmId));
  },
  // Listen for the main process closing a native notification
  onAlarmDismissFromMain: (callback: () => void) => {
    ipcRenderer.on('alarm-dismiss-from-main', () => callback());
  },
  // Remove event listeners
  removeAlarmsUpdatedListener: () => {
    ipcRenderer.removeAllListeners('alarms-updated');
  },
  removeAlarmTriggeredListener: () => {
    ipcRenderer.removeAllListeners('alarm-triggered');
  },
  // Countdown window
  toggleCountdownWindow: () => {
    ipcRenderer.send('countdown-window-toggle');
  },
  closeCountdownWindow: () => {
    ipcRenderer.send('countdown-window-close');
  },
  showCountdownWindowMenu: () => ipcRenderer.send('countdown-window-menu'),
  onCountdownWindowState: (callback: (visible: boolean) => void) => {
    ipcRenderer.on('countdown-window-state', (_event, visible: boolean) => callback(visible));
  },
  onCountdownUpdate: (callback: (text: string) => void) => {
    ipcRenderer.on('countdown-update', (_event, text: string) => callback(text));
  },
  onCountdownMenuButtonVisibility: (callback: (visible: boolean) => void) => {
    ipcRenderer.on('countdown-menu-button-visibility', (_event, visible: boolean) => callback(visible));
  },
  onCountdownFontSize: (callback: (size: number) => void) => {
    ipcRenderer.on('countdown-font-size', (_event, size) => callback(size));
  },
  // Time zone
  getTimezones: () => ipcRenderer.invoke('get-timezones') as Promise<string[]>,
  getCurrentTimezone: () => ipcRenderer.invoke('get-current-timezone') as Promise<{ effective: string; isSystem: boolean }>,
  setTimezone: (tz: string | null) => ipcRenderer.invoke('set-timezone', tz) as Promise<{ effective: string; isSystem: boolean }>,
  onTimezoneUpdated: (callback: (info: { effective: string; isSystem: boolean }) => void) => {
    ipcRenderer.on('timezone-updated', (_event, info) => callback(info));
  },
});

