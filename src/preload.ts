import { contextBridge, ipcRenderer } from 'electron';

// Тип для будильника
export interface Alarm {
  id: string;
  hour: number;
  minute: number;
  enabled: boolean;
}

// Предоставляем безопасный API для renderer процесса
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
  // Команды будильника
  addAlarm: (alarm: Alarm) => {
    ipcRenderer.send('alarm-add', alarm);
  },
  updateAlarm: (alarm: Alarm) => {
    ipcRenderer.send('alarm-update', alarm);
  },
  deleteAlarm: (alarmId: string) => {
    ipcRenderer.send('alarm-delete', alarmId);
  },
  getAllAlarms: () => {
    ipcRenderer.send('alarm-get-all');
  },
  dismissAlarm: () => {
    ipcRenderer.send('alarm-dismiss');
  },
  // Слушатели событий от main процесса
  onAlarmsUpdated: (callback: (alarms: Alarm[]) => void) => {
    ipcRenderer.on('alarms-updated', (_event, alarms) => callback(alarms));
  },
  onAlarmTriggered: (callback: (alarmId: string) => void) => {
    ipcRenderer.on('alarm-triggered', (_event, alarmId) => callback(alarmId));
  },
  // Обработчик для сообщения от main процесса о закрытии нативного уведомления
  onAlarmDismissFromMain: (callback: () => void) => {
    ipcRenderer.on('alarm-dismiss-from-main', () => callback());
  },
  // Удаление слушателей
  removeAlarmsUpdatedListener: () => {
    ipcRenderer.removeAllListeners('alarms-updated');
  },
  removeAlarmTriggeredListener: () => {
    ipcRenderer.removeAllListeners('alarm-triggered');
  },
  // Окно отсчёта времени
  toggleCountdownWindow: () => {
    ipcRenderer.send('countdown-window-toggle');
  },
  closeCountdownWindow: () => {
    ipcRenderer.send('countdown-window-close');
  },
  onCountdownWindowState: (callback: (visible: boolean) => void) => {
    ipcRenderer.on('countdown-window-state', (_event, visible: boolean) => callback(visible));
  },
  onCountdownUpdate: (callback: (text: string) => void) => {
    ipcRenderer.on('countdown-update', (_event, text: string) => callback(text));
  },
});

