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
  // Слушатели событий от main процесса
  onAlarmsUpdated: (callback: (alarms: Alarm[]) => void) => {
    ipcRenderer.on('alarms-updated', (_event, alarms) => callback(alarms));
  },
  onAlarmTriggered: (callback: (alarmId: string) => void) => {
    ipcRenderer.on('alarm-triggered', (_event, alarmId) => callback(alarmId));
  },
  // Удаление слушателей
  removeAlarmsUpdatedListener: () => {
    ipcRenderer.removeAllListeners('alarms-updated');
  },
  removeAlarmTriggeredListener: () => {
    ipcRenderer.removeAllListeners('alarm-triggered');
  }
});

