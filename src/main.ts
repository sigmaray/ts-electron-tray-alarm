import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, screen, Notification } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
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
let countdownWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

// Константа для управления разрешением только одного экземпляра приложения
const ALLOW_ONLY_ONE_INSTANCE = process.env.ALLOW_ONLY_ONE_INSTANCE !== 'false';

// Экспортируем tray для тестирования (только в development режиме)
if (process.env.NODE_ENV === 'test' || process.env.ELECTRON_DISABLE_SANDBOX) {
  (global as any).__tray__ = () => tray;
}

// Тип для будильника
interface Alarm {
  id: string;
  hour: number;
  minute: number;
  second: number;
  enabled: boolean;
  recurring: boolean;
}

let alarms: Alarm[] = [];
let alarmCheckInterval: NodeJS.Timeout | null = null;
let lastTriggeredDate: string = ''; // Для отслеживания сработавших будильников сегодня
let triggeredAlarmsToday: Set<string> = new Set(); // ID будильников, сработавших сегодня
let blinkInterval: NodeJS.Timeout | null = null;
let isBlinking = false;
let isAlarmActive = false; // Флаг активного будильника (играет звук)

// Путь к файлу настроек
function getSettingsPath(): string {
  const appPath = app.getAppPath();
  return path.join(appPath, 'settings.json');
}

interface AppSettings {
  alarms: Alarm[];
  countdownWindowVisible: boolean;
}

// Загрузка настроек из файла
function loadSettings(): AppSettings {
  try {
    const settingsPath = getSettingsPath();
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(data);
      return {
        alarms: settings.alarms && Array.isArray(settings.alarms) ? settings.alarms : [],
        countdownWindowVisible: Boolean(settings.countdownWindowVisible),
      };
    }
  } catch (error) {
    console.error('Ошибка при загрузке настроек:', error);
  }
  return { alarms: [], countdownWindowVisible: false };
}

// Сохранение настроек в файл
function saveSettings(): void {
  try {
    const settingsPath = getSettingsPath();
    const settings: AppSettings = {
      alarms,
      countdownWindowVisible: countdownWindowVisiblePref,
    };
    const data = JSON.stringify(settings, null, 2);
    fs.writeFileSync(settingsPath, data, 'utf-8');
  } catch (error) {
    console.error('Ошибка при сохранении настроек:', error);
  }
}

let countdownWindowVisiblePref = false;

// Сохранение будильников в файл (сохраняет все настройки)
function saveAlarms(): void {
  saveSettings();
}

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

function createTextIcon(text: string, isBlinking: boolean = false): Electron.NativeImage {
  const size = 22; // Стандартный размер для трея
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  
  // Определяем цвет в зависимости от состояния
  let bgColor: string;
  const textColor = '#FFFFFF';
  
  if (isBlinking) {
    // Мигание: красный
    bgColor = '#FF0000';
  } else {
    // Приглушенный синий фон (соответствует цвету фона окна)
    bgColor = '#5b7fa6';
  }
  
  // Рисуем фон
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, size, size);
  
  // Подбираем размер шрифта в зависимости от длины текста
  const maxWidth = size - 4; // Оставляем отступы по 2px с каждой стороны
  let fontSize = 14; // Начальный размер шрифта
  let textWidth = 0;
  
  // Уменьшаем размер шрифта, пока текст не влезет
  do {
    ctx.font = `bold ${fontSize}px Arial`;
    const metrics = ctx.measureText(text);
    textWidth = metrics.width;
    
    if (textWidth > maxWidth && fontSize > 6) {
      fontSize -= 0.5;
    } else {
      break;
    }
  } while (textWidth > maxWidth && fontSize > 6);
  
  // Рисуем текст
  ctx.fillStyle = textColor;
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
  alarmTime.setHours(alarm.hour, alarm.minute, alarm.second, 0);
  
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
  
  // Для больших значений показываем в часах с округлением
  const hours = seconds / 3600;
  const roundedHours = Math.round(hours);
  
  // Если округленное значение равно исходному (целое число), показываем без десятичной части
  if (roundedHours === hours) {
    return `${roundedHours}h`;
  }
  
  // Иначе показываем округленное значение
  return `${roundedHours}h`;
}

function formatTimeForTooltip(seconds: number): string {
  if (seconds <= 0) return '0с';
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}ч`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}м`);
  }
  if (secs > 0 || parts.length === 0) {
    parts.push(`${secs}с`);
  }
  
  return parts.join(' ');
}

function updateTrayIcon(): void {
  if (!tray) return;
  
  let icon: Electron.NativeImage;
  let tooltipText: string;
  
  if (isAlarmActive) {
    // Мигание: красная иконка с восклицательным знаком
    icon = createTextIcon('!', isBlinking);
    tooltipText = '⏰ Будильник!';
  } else {
    const nearestAlarm = getNearestAlarm();
    
    if (nearestAlarm) {
      const timeUntil = getTimeUntilAlarm(nearestAlarm);
      const text = formatTimeForTray(timeUntil);
      icon = createTextIcon(text, false);
      
      const alarmTime = `${String(nearestAlarm.hour).padStart(2, '0')}:${String(nearestAlarm.minute).padStart(2, '0')}:${String(nearestAlarm.second).padStart(2, '0')}`;
      tooltipText = `Будильник: ${alarmTime} (через ${formatTimeForTooltip(timeUntil)})`;
    } else {
      icon = createTextIcon('—', false);
      tooltipText = 'Будильник не установлен';
    }
  }
  
  tray.setImage(icon);
  tray.setToolTip(tooltipText);
}

function formatTimeForCountdownWindow(seconds: number): string {
  if (seconds <= 0) return '—';
  if (seconds < 60) return '< 1м';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}ч`);
  parts.push(`${minutes}м`);
  return parts.join(' ');
}

function getCountdownText(): string {
  const nearestAlarm = getNearestAlarm();
  if (!nearestAlarm) return '—';
  const timeUntil = getTimeUntilAlarm(nearestAlarm);
  return formatTimeForCountdownWindow(timeUntil);
}

function updateCountdownWindow(): void {
  if (countdownWindow && !countdownWindow.isDestroyed()) {
    const text = getCountdownText();
    countdownWindow.webContents.send('countdown-update', text);
  }
}

function createCountdownWindow(): void {
  if (countdownWindow && !countdownWindow.isDestroyed()) {
    countdownWindow.show();
    updateCountdownWindow();
    countdownWindowVisiblePref = true;
    saveSettings();
    sendCountdownWindowState();
    return;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  const { x: screenX, y: screenY } = primaryDisplay.workArea;

  const windowWidth = 280;
  const windowHeight = 70;
  const x = screenX + screenWidth - windowWidth;
  const y = screenY + screenHeight - windowHeight;

  countdownWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x,
    y,
    frame: false,
    alwaysOnTop: true,
    transparent: true,
    resizable: false,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  countdownWindow.loadFile(path.join(__dirname, 'countdown.html'));

  countdownWindow.once('ready-to-show', () => {
    if (countdownWindow) {
      updateCountdownWindow();
      countdownWindow.show();
      countdownWindowVisiblePref = true;
      saveSettings();
      sendCountdownWindowState();
    }
  });

  countdownWindow.on('closed', () => {
    countdownWindow = null;
    countdownWindowVisiblePref = false;
    saveSettings();
    sendCountdownWindowState();
  });
}

function destroyCountdownWindow(): void {
  if (countdownWindow) {
    countdownWindow.close();
    countdownWindow = null;
  }
  countdownWindowVisiblePref = false;
  saveSettings();
  sendCountdownWindowState();
}

function toggleCountdownWindow(): void {
  if (countdownWindow && !countdownWindow.isDestroyed()) {
    destroyCountdownWindow();
  } else {
    createCountdownWindow();
  }
}

function sendCountdownWindowState(): void {
  const visible = !!(countdownWindow && !countdownWindow.isDestroyed());
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('countdown-window-state', visible);
  }
}

function startBlinking(): void {
  if (blinkInterval) return;
  
  isBlinking = false;
  blinkInterval = setInterval(() => {
    isBlinking = !isBlinking;
    updateTrayIcon();
  }, 500); // Мигание каждые 500мс
}

function stopBlinking(): void {
  if (blinkInterval) {
    clearInterval(blinkInterval);
    blinkInterval = null;
  }
  isBlinking = false;
  isAlarmActive = false;
  updateTrayIcon();
}

function checkAlarms(): void {
  const now = new Date();
  const currentDate = now.toDateString();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const currentSecond = now.getSeconds();
  
  // Сбрасываем множество сработавших будильников при смене дня
  if (lastTriggeredDate !== currentDate) {
    triggeredAlarmsToday.clear();
    lastTriggeredDate = currentDate;
  }
  
  for (const alarm of alarms) {
    if (!alarm.enabled) continue;
    
    // Проверяем, не сработал ли уже этот будильник сегодня (только для повторяющихся)
    if (alarm.recurring && triggeredAlarmsToday.has(alarm.id)) continue;
    
    // Проверяем точное время (час, минута и секунда)
    if (alarm.hour === currentHour && alarm.minute === currentMinute && alarm.second === currentSecond) {
      // Триггерим будильник
      triggerAlarm(alarm);
      
      // Если будильник повторяющийся, добавляем в список сработавших сегодня
      if (alarm.recurring) {
        triggeredAlarmsToday.add(alarm.id);
      } else {
        // Если будильник неповторяющийся, отключаем его после срабатывания
        const index = alarms.findIndex(a => a.id === alarm.id);
        if (index !== -1) {
          alarms[index].enabled = false;
          saveAlarms();
          updateTrayIcon();
          sendAlarmsToRenderer();
        }
      }
    }
  }
}

function triggerAlarm(alarm: Alarm): void {
  // Запускаем мигание иконки
  isAlarmActive = true;
  startBlinking();
  
  // Показываем уведомление
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: '⏰ Будильник!',
      body: `Время: ${String(alarm.hour).padStart(2, '0')}:${String(alarm.minute).padStart(2, '0')}:${String(alarm.second).padStart(2, '0')}`,
      urgency: 'critical',
    });
    
    // Останавливаем звук и мигание при закрытии уведомления
    notification.on('close', () => {
      stopBlinking();
      // Отправляем сообщение в renderer для остановки звука
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('alarm-dismiss-from-main');
      }
    });
    
    // Останавливаем звук и мигание при клике на уведомление
    notification.on('click', () => {
      stopBlinking();
      // Отправляем сообщение в renderer для остановки звука
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('alarm-dismiss-from-main');
      }
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
    updateCountdownWindow();
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
  
  // Градиентный фон (приглушенный синий)
  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, '#5b7fa6');
  gradient.addColorStop(1, '#4a6fa5');
  
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

  // Отправляем загруженные будильники в renderer после загрузки страницы
  mainWindow.webContents.once('did-finish-load', () => {
    sendAlarmsToRenderer();
    sendCountdownWindowState();
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
  tray = new Tray(createTextIcon('—', false));

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

// Функция инициализации приложения
function initializeApp(): void {
  // Загружаем настройки из файла при запуске
  const settings = loadSettings();
  alarms = settings.alarms;
  countdownWindowVisiblePref = settings.countdownWindowVisible;

  createWindow();
  createTray();
  startAlarmChecker();

  if (countdownWindowVisiblePref) {
    createCountdownWindow();
  }

  // Обработчики для управления будильниками
  ipcMain.on('alarm-add', (_event, alarm: Alarm) => {
    alarms.push(alarm);
    saveAlarms();
    updateTrayIcon();
    sendAlarmsToRenderer();
  });

  ipcMain.on('alarm-update', (_event, alarm: Alarm) => {
    const index = alarms.findIndex(a => a.id === alarm.id);
    if (index !== -1) {
      alarms[index] = alarm;
      saveAlarms();
      updateTrayIcon();
      sendAlarmsToRenderer();
    }
  });

  ipcMain.on('alarm-delete', (_event, alarmId: string) => {
    alarms = alarms.filter(a => a.id !== alarmId);
    saveAlarms();
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

  // Обработчик остановки мигания будильника (когда пользователь отключает звук)
  ipcMain.on('alarm-dismiss', () => {
    stopBlinking();
  });

  // Окно отсчёта времени
  ipcMain.on('countdown-window-toggle', () => {
    toggleCountdownWindow();
  });
  ipcMain.on('countdown-window-close', () => {
    destroyCountdownWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });
}

// Обеспечиваем, что только один экземпляр приложения может быть запущен (если включено)
if (ALLOW_ONLY_ONE_INSTANCE) {
  const gotTheLock = app.requestSingleInstanceLock();

  if (!gotTheLock) {
    // Если другой экземпляр уже запущен, закрываем этот
    app.quit();
  } else {
    // Обрабатываем попытку запуска второго экземпляра
    app.on('second-instance', () => {
      // Если пользователь пытается запустить второй экземпляр, показываем существующее окно
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });

    app.whenReady().then(() => {
      initializeApp();
    });
  }
} else {
  // Если разрешено несколько экземпляров, запускаем приложение без проверки блокировки
  app.whenReady().then(() => {
    initializeApp();
  });
}

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

