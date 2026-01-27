import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, screen, Notification } from 'electron';
import * as path from 'path';
import { createCanvas } from 'canvas';

// Расширяем тип app для свойства isQuitting
declare global {
  namespace Electron {
    interface App {
      isQuitting?: boolean;
    }
  }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

// Экспортируем tray для тестирования (только в development режиме)
if (process.env.NODE_ENV === 'test' || process.env.ELECTRON_DISABLE_SANDBOX) {
  (global as any).__tray__ = () => tray;
}

// Тип для будильника
interface Alarm {
  id: string;
  hour: number;
  minute: number;
  enabled: boolean;
}

let alarms: Alarm[] = [];
let alarmCheckInterval: NodeJS.Timeout | null = null;
let lastTriggeredDate: string = ''; // Для отслеживания сработавших будильников сегодня
let triggeredAlarmsToday: Set<string> = new Set(); // ID будильников, сработавших сегодня

function updateTrayMenu(): void {
  if (!tray) return;
  const isVisible = mainWindow?.isVisible() ?? false;
  const toggleLabel = isVisible ? 'Свернуть в трей' : 'Показать';

  const contextMenu = Menu.buildFromTemplate([
    {
      label: toggleLabel,
      click: () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
        updateTrayMenu();
      },
    },
    {
      label: 'Выход',
      click: async () => {
        const result = await dialog.showMessageBox(mainWindow || null as any, {
          type: 'question',
          buttons: ['Отмена', 'Закрыть'],
          defaultId: 0,
          cancelId: 0,
          title: 'Подтверждение',
          message: 'Вы уверены, что хотите закрыть приложение?'
        });

        if (result.response === 1) {
          app.isQuitting = true;
          app.quit();
        }
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function createTextIcon(text: string): Electron.NativeImage {
  const size = 22; // Стандартный размер для трея
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  
  // Фиолетовый фон
  const bgColor = '#7c3aed';
  const textColor = '#FFFFFF';
  
  // Рисуем фон
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, size, size);
  
  // Рисуем текст
  ctx.fillStyle = textColor;
  ctx.font = 'bold 12px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2);
  
  // Конвертируем canvas в buffer
  const buffer = canvas.toBuffer('image/png');
  return nativeImage.createFromBuffer(buffer);
}

function getTimeUntilAlarm(alarm: Alarm): number {
  const now = new Date();
  const alarmTime = new Date();
  alarmTime.setHours(alarm.hour, alarm.minute, 0, 0);
  
  // Если время будильника уже прошло сегодня, берем завтрашний день
  if (alarmTime <= now) {
    alarmTime.setDate(alarmTime.getDate() + 1);
  }
  
  return Math.floor((alarmTime.getTime() - now.getTime()) / 1000);
}

function getNearestAlarm(): Alarm | null {
  const enabledAlarms = alarms.filter(a => a.enabled);
  if (enabledAlarms.length === 0) return null;
  
  let nearest: Alarm | null = null;
  let nearestTime = Infinity;
  
  for (const alarm of enabledAlarms) {
    const timeUntil = getTimeUntilAlarm(alarm);
    if (timeUntil < nearestTime) {
      nearestTime = timeUntil;
      nearest = alarm;
    }
  }
  
  return nearest;
}

function formatTimeForTray(seconds: number): string {
  if (seconds <= 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  
  const mins = Math.floor(seconds / 60);
  if (mins < 60) {
    return `${mins}m`;
  }
  
  // Для больших значений показываем в часах с одной десятичной цифрой
  const hours = seconds / 3600;
  return `${hours.toFixed(1)}h`;
}

function updateTrayIcon(): void {
  if (!tray) return;
  
  const nearestAlarm = getNearestAlarm();
  
  if (nearestAlarm) {
    const timeUntil = getTimeUntilAlarm(nearestAlarm);
    const text = formatTimeForTray(timeUntil);
    const icon = createTextIcon(text);
    tray.setImage(icon);
    
    const alarmTime = `${String(nearestAlarm.hour).padStart(2, '0')}:${String(nearestAlarm.minute).padStart(2, '0')}`;
    tray.setToolTip(`Будильник: ${alarmTime} (через ${formatTimeForTray(timeUntil)})`);
  } else {
    const icon = createTextIcon('—');
    tray.setImage(icon);
    tray.setToolTip('Будильник не установлен');
  }
}

function checkAlarms(): void {
  const now = new Date();
  const currentDate = now.toDateString();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  
  // Сбрасываем множество сработавших будильников при смене дня
  if (lastTriggeredDate !== currentDate) {
    triggeredAlarmsToday.clear();
    lastTriggeredDate = currentDate;
  }
  
  for (const alarm of alarms) {
    if (!alarm.enabled) continue;
    
    // Проверяем, не сработал ли уже этот будильник сегодня
    if (triggeredAlarmsToday.has(alarm.id)) continue;
    
    // Проверяем точное время (только минута, без секунд)
    if (alarm.hour === currentHour && alarm.minute === currentMinute) {
      // Триггерим будильник
      triggerAlarm(alarm);
      triggeredAlarmsToday.add(alarm.id);
    }
  }
}

function triggerAlarm(alarm: Alarm): void {
  // Показываем уведомление
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: '⏰ Будильник!',
      body: `Время: ${String(alarm.hour).padStart(2, '0')}:${String(alarm.minute).padStart(2, '0')}`,
      urgency: 'critical',
    });
    notification.show();
  }
  
  // Показываем окно если оно скрыто
  if (mainWindow && !mainWindow.isVisible()) {
    mainWindow.show();
    mainWindow.focus();
  }
  
  // Отправляем событие в renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('alarm-triggered', alarm.id);
  }
}

function startAlarmChecker(): void {
  if (alarmCheckInterval) return;
  
  // Проверяем каждую секунду
  alarmCheckInterval = setInterval(() => {
    checkAlarms();
    updateTrayIcon(); // Обновляем иконку трея с актуальным временем
  }, 1000);
}

function stopAlarmChecker(): void {
  if (alarmCheckInterval) {
    clearInterval(alarmCheckInterval);
    alarmCheckInterval = null;
  }
}

function createAppIcon(): Electron.NativeImage {
  const size = 256;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  
  // Градиентный фон (фиолетовый)
  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, '#667eea');
  gradient.addColorStop(1, '#764ba2');
  
  // Рисуем закругленный прямоугольник
  const radius = size * 0.15;
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(size - radius, 0);
  ctx.quadraticCurveTo(size, 0, size, radius);
  ctx.lineTo(size, size - radius);
  ctx.quadraticCurveTo(size, size, size - radius, size);
  ctx.lineTo(radius, size);
  ctx.quadraticCurveTo(0, size, 0, size - radius);
  ctx.lineTo(0, radius);
  ctx.quadraticCurveTo(0, 0, radius, 0);
  ctx.closePath();
  ctx.fill();
  
  // Рисуем иконку будильника
  ctx.strokeStyle = '#FFFFFF';
  ctx.fillStyle = '#FFFFFF';
  ctx.lineWidth = size * 0.03;
  
  // Циферблат
  const centerX = size / 2;
  const centerY = size / 2;
  const clockRadius = size * 0.3;
  
  ctx.beginPath();
  ctx.arc(centerX, centerY, clockRadius, 0, 2 * Math.PI);
  ctx.stroke();
  
  // Стрелки часов (показывают 7:00 - время будильника)
  const hourAngle = (7 * 30 - 90) * (Math.PI / 180);
  const minuteAngle = (0 * 6 - 90) * (Math.PI / 180);
  
  const hourLength = clockRadius * 0.5;
  const minuteLength = clockRadius * 0.7;
  
  // Часовая стрелка
  ctx.beginPath();
  ctx.moveTo(centerX, centerY);
  ctx.lineTo(
    centerX + Math.cos(hourAngle) * hourLength,
    centerY + Math.sin(hourAngle) * hourLength
  );
  ctx.lineWidth = size * 0.04;
  ctx.stroke();
  
  // Минутная стрелка
  ctx.beginPath();
  ctx.moveTo(centerX, centerY);
  ctx.lineTo(
    centerX + Math.cos(minuteAngle) * minuteLength,
    centerY + Math.sin(minuteAngle) * minuteLength
  );
  ctx.lineWidth = size * 0.025;
  ctx.stroke();
  
  // Центральная точка
  ctx.beginPath();
  ctx.arc(centerX, centerY, size * 0.02, 0, 2 * Math.PI);
  ctx.fill();
  
  // Конвертируем canvas в buffer
  const buffer = canvas.toBuffer('image/png');
  return nativeImage.createFromBuffer(buffer);
}

function createWindow(): void {
  const appIcon = createAppIcon();
  
  // Получаем основной монитор
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  const { x, y } = primaryDisplay.workArea;
  
  // Вычисляем позицию для центрирования окна на основном мониторе
  const windowWidth = 800;
  const windowHeight = 900;
  const windowX = x + Math.floor((width - windowWidth) / 2);
  const windowY = y + Math.floor((height - windowHeight) / 2);
  
  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: windowX,
    y: windowY,
    icon: appIcon,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false, // Всегда запускаем приложение свернутым
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Скрываем окно после загрузки
  mainWindow.once('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.hide();
    }
  });

  // Обработка закрытия окна - сворачиваем в tray вместо закрытия
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('minimize', () => {
    mainWindow?.hide();
  });

  mainWindow.on('show', updateTrayMenu);
  mainWindow.on('hide', updateTrayMenu);
}

function createTray(): void {
  // Начальная иконка с прочерком
  tray = new Tray(createTextIcon('—'));

  updateTrayMenu();
  updateTrayIcon();

  // ЛКМ по иконке: показать/скрыть окно
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
    updateTrayMenu();
  });

  // Двойной клик по иконке также показывает окно
  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
    updateTrayMenu();
  });
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  startAlarmChecker();

  // Обработчики для управления будильниками
  ipcMain.on('alarm-add', (_event, alarm: Alarm) => {
    alarms.push(alarm);
    updateTrayIcon();
    sendAlarmsToRenderer();
  });

  ipcMain.on('alarm-update', (_event, alarm: Alarm) => {
    const index = alarms.findIndex(a => a.id === alarm.id);
    if (index !== -1) {
      alarms[index] = alarm;
      updateTrayIcon();
      sendAlarmsToRenderer();
    }
  });

  ipcMain.on('alarm-delete', (_event, alarmId: string) => {
    alarms = alarms.filter(a => a.id !== alarmId);
    updateTrayIcon();
    sendAlarmsToRenderer();
  });

  ipcMain.on('alarm-get-all', () => {
    sendAlarmsToRenderer();
  });

  // Обработчик сворачивания окна в трей
  ipcMain.on('minimize-window', () => {
    if (mainWindow) {
      mainWindow.hide();
      updateTrayMenu();
    }
  });

  // Обработчик эмуляции клика по иконке трея (для тестов)
  ipcMain.on('tray-click', () => {
    if (tray && mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
      updateTrayMenu();
    }
  });

  // Обработчик закрытия приложения
  ipcMain.on('close-app', () => {
    app.isQuitting = true;
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });
});

function sendAlarmsToRenderer(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('alarms-updated', alarms);
  }
}

app.on('window-all-closed', () => {
  // Не закрываем приложение при закрытии всех окон
  // Оно будет работать в tray
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopAlarmChecker();
});

