import { app, BrowserWindow, Tray, Menu, nativeImage, dialog, screen, Notification } from 'electron';
import * as path from 'path';
import { createCanvas } from 'canvas';
import { Alarm, createSettingsStore } from './settings';
import { registerIpcHandlers } from './ipc-handlers';

// Extend the Electron app type with the isQuitting flag
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

// Control whether only one app instance may run
const ALLOW_ONLY_ONE_INSTANCE = process.env.ALLOW_ONLY_ONE_INSTANCE !== 'false';

// Expose the tray for tests in development mode
if (process.env.NODE_ENV === 'test' || process.env.ELECTRON_DISABLE_SANDBOX) {
  (global as any).__tray__ = () => tray;
}

// Alarm type
let alarms: Alarm[] = [];
let alarmCheckInterval: NodeJS.Timeout | null = null;
let lastTriggeredDate: string = ''; // Track alarms that have fired today
let triggeredAlarmsToday: Set<string> = new Set(); // IDs of alarms that have fired today
let blinkInterval: NodeJS.Timeout | null = null;
let isBlinking = false;
let isAlarmActive = false; // Whether an alarm is currently sounding

let settingsStore: ReturnType<typeof createSettingsStore> | null = null;

// System time zone
function getSystemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// Active time zone from settings, or the system time zone
function getEffectiveTimezone(): string {
  if (timezonePref && timezonePref.trim() !== '') {
    return timezonePref;
  }
  return getSystemTimezone();
}

// Current local date and time in the specified time zone
function getLocalTimeInTimezone(tz: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string) => {
    const p = parts.find(x => x.type === type);
    return p ? parseInt(p.value, 10) : 0;
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

// UTC timestamp for the given date and time in time zone tz
function getTimestampInTimezone(tz: string, year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const dayNoonUTC = Date.UTC(year, month - 1, day, 12, 0, 0);
  const parts = formatter.formatToParts(dayNoonUTC);
  const get = (type: string) => {
    const p = parts.find(x => x.type === type);
    return p ? parseInt(p.value, 10) : 0;
  };
  const localHour = get('hour');
  const localMinute = get('minute');
  const localSecond = get('second');
  const offsetSec = (localHour * 3600 + localMinute * 60 + localSecond) - 12 * 3600;
  const offsetMs = offsetSec * 1000;
  return Date.UTC(year, month - 1, day, hour, minute, second) - offsetMs;
}

/** Shift a Gregorian calendar date. Date.UTC normalizes month/year boundaries without using the system time zone. */
function addGregorianCalendarDays(year: number, month: number, day: number, deltaDays: number): { year: number; month: number; day: number } {
  const ms = Date.UTC(year, month - 1, day + deltaDays);
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

let countdownWindowVisiblePref = false;
let timezonePref: string | null = null; // null means use the system time zone

function saveSettings(): void {
  settingsStore?.save({ alarms, countdownWindowVisible: countdownWindowVisiblePref, timezone: timezonePref });
}

// Save alarms and all other settings to disk
function saveAlarms(): void {
  saveSettings();
}

function updateTrayMenu(): void {
  if (!tray) return;
  const isVisible = mainWindow?.isVisible() ?? false;
  const toggleLabel = isVisible ? 'Minimize to Tray' : 'Show';

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
      label: 'Quit',
      click: async () => {
        const result = await dialog.showMessageBox(mainWindow || null as any, {
          type: 'question',
          buttons: ['Cancel', 'Close'],
          defaultId: 0,
          cancelId: 0,
          title: 'Confirmation',
          message: 'Are you sure you want to quit the application?'
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
  const size = 22; // Standard tray icon size
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  
  // Choose a color based on the current state
  let bgColor: string;
  const textColor = '#FFFFFF';
  
  if (isBlinking) {
    // Red while blinking
    bgColor = '#FF0000';
  } else {
    // Muted blue background matching the window
    bgColor = '#5b7fa6';
  }
  
  // Draw the background
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, size, size);
  
  // Choose a font size based on the text length
  const maxWidth = size - 4; // Leave 2px of padding on each side
  let fontSize = 14; // Initial font size
  let textWidth = 0;
  
  // Reduce the font size until the text fits
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
  
  // Draw the text
  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2);
  
  // Convert the canvas to a buffer
  const buffer = canvas.toBuffer('image/png');
  return nativeImage.createFromBuffer(buffer);
}

/** Alarm instant for a calendar date (year/month/day) in time zone tz. */
function getAlarmTimestampOnCalendarDay(
  alarm: Alarm,
  tz: string,
  year: number,
  month: number,
  day: number,
): number {
  return getTimestampInTimezone(tz, year, month, day, alarm.hour, alarm.minute, alarm.second);
}

function getTimeUntilAlarm(alarm: Alarm): number {
  const tz = getEffectiveTimezone();
  const now = new Date();
  const local = getLocalTimeInTimezone(tz);
  let alarmTs = getAlarmTimestampOnCalendarDay(alarm, tz, local.year, local.month, local.day);
  if (alarmTs <= now.getTime()) {
    const next = addGregorianCalendarDays(local.year, local.month, local.day, 1);
    alarmTs = getAlarmTimestampOnCalendarDay(alarm, tz, next.year, next.month, next.day);
  }
  return Math.floor((alarmTs - now.getTime()) / 1000);
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
  
  // Show larger values as rounded hours
  const hours = seconds / 3600;
  const roundedHours = Math.round(hours);
  
  // Omit the decimal part when the rounded value is already an integer
  if (roundedHours === hours) {
    return `${roundedHours}h`;
  }
  
  // Otherwise, show the rounded value
  return `${roundedHours}h`;
}

function formatTimeForTooltip(seconds: number): string {
  if (seconds <= 0) return '0s';
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (secs > 0 || parts.length === 0) {
    parts.push(`${secs}s`);
  }
  
  return parts.join(' ');
}

function updateTrayIcon(): void {
  if (!tray) return;
  
  let icon: Electron.NativeImage;
  let tooltipText: string;
  
  if (isAlarmActive) {
    // Blink a red icon with an exclamation mark
    icon = createTextIcon('!', isBlinking);
    tooltipText = '⏰ Alarm!';
  } else {
    const nearestAlarm = getNearestAlarm();
    
    if (nearestAlarm) {
      const timeUntil = getTimeUntilAlarm(nearestAlarm);
      const text = formatTimeForTray(timeUntil);
      icon = createTextIcon(text, false);
      
      const alarmTime = `${String(nearestAlarm.hour).padStart(2, '0')}:${String(nearestAlarm.minute).padStart(2, '0')}:${String(nearestAlarm.second).padStart(2, '0')}`;
      tooltipText = `Alarm: ${alarmTime} (in ${formatTimeForTooltip(timeUntil)})`;
    } else {
      icon = createTextIcon('—', false);
      tooltipText = 'No alarm set';
    }
  }
  
  tray.setImage(icon);
  tray.setToolTip(tooltipText);
}

function formatTimeForCountdownWindow(seconds: number): string {
  if (seconds <= 0) return '—';
  if (seconds < 60) return '< 1m';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
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
  }, 500); // Blink every 500 ms
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
  const tz = getEffectiveTimezone();
  const local = getLocalTimeInTimezone(tz);
  const currentDate = `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
  const nowMs = Date.now();

  // Reset the set of triggered alarms when the day changes
  if (lastTriggeredDate !== currentDate) {
    triggeredAlarmsToday.clear();
    lastTriggeredDate = currentDate;
  }

  for (const alarm of alarms) {
    if (!alarm.enabled) continue;

    // For recurring alarms, check whether this alarm has already fired today
    if (alarm.recurring && triggeredAlarmsToday.has(alarm.id)) continue;

    const fireTs = getAlarmTimestampOnCalendarDay(alarm, tz, local.year, local.month, local.day);
    // Fire if the target time has passed, even after an event loop delay or system sleep
    if (nowMs < fireTs) continue;

    triggerAlarm(alarm);

    if (alarm.recurring) {
      triggeredAlarmsToday.add(alarm.id);
    } else {
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

function triggerAlarm(alarm: Alarm): void {
  // Start blinking the tray icon
  isAlarmActive = true;
  startBlinking();
  
  // Show a notification
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: '⏰ Alarm!',
      body: `Time: ${String(alarm.hour).padStart(2, '0')}:${String(alarm.minute).padStart(2, '0')}:${String(alarm.second).padStart(2, '0')}`,
      urgency: 'critical',
    });
    
    // Stop the sound and blinking when the notification closes
    notification.on('close', () => {
      stopBlinking();
      // Tell the renderer to stop the sound
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('alarm-dismiss-from-main');
      }
    });
    
    // Stop the sound and blinking when the notification is clicked
    notification.on('click', () => {
      stopBlinking();
      // Tell the renderer to stop the sound
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('alarm-dismiss-from-main');
      }
    });
    
    notification.show();
  }
  
  // Show the window if it is hidden
  if (mainWindow && !mainWindow.isVisible()) {
    mainWindow.show();
    mainWindow.focus();
  }
  
  // Send an event to the renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('alarm-triggered', alarm.id);
  }
}

function startAlarmChecker(): void {
  if (alarmCheckInterval) return;
  
  // Check once per second
  alarmCheckInterval = setInterval(() => {
    checkAlarms();
    updateTrayIcon(); // Update the tray icon with the latest time
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
  
  // Muted blue gradient background
  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, '#5b7fa6');
  gradient.addColorStop(1, '#4a6fa5');
  
  // Draw the rounded rectangle
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
  
  // Draw the alarm clock icon
  ctx.strokeStyle = '#FFFFFF';
  ctx.fillStyle = '#FFFFFF';
  ctx.lineWidth = size * 0.03;
  
  // Draw the clock face
  const centerX = size / 2;
  const centerY = size / 2;
  const clockRadius = size * 0.3;
  
  ctx.beginPath();
  ctx.arc(centerX, centerY, clockRadius, 0, 2 * Math.PI);
  ctx.stroke();
  
  // Clock hands showing 7:00
  const hourAngle = (7 * 30 - 90) * (Math.PI / 180);
  const minuteAngle = (0 * 6 - 90) * (Math.PI / 180);
  
  const hourLength = clockRadius * 0.5;
  const minuteLength = clockRadius * 0.7;
  
  // Hour hand
  ctx.beginPath();
  ctx.moveTo(centerX, centerY);
  ctx.lineTo(
    centerX + Math.cos(hourAngle) * hourLength,
    centerY + Math.sin(hourAngle) * hourLength
  );
  ctx.lineWidth = size * 0.04;
  ctx.stroke();
  
  // Minute hand
  ctx.beginPath();
  ctx.moveTo(centerX, centerY);
  ctx.lineTo(
    centerX + Math.cos(minuteAngle) * minuteLength,
    centerY + Math.sin(minuteAngle) * minuteLength
  );
  ctx.lineWidth = size * 0.025;
  ctx.stroke();
  
  // Center dot
  ctx.beginPath();
  ctx.arc(centerX, centerY, size * 0.02, 0, 2 * Math.PI);
  ctx.fill();
  
  // Convert the canvas to a buffer
  const buffer = canvas.toBuffer('image/png');
  return nativeImage.createFromBuffer(buffer);
}

function createWindow(): void {
  const appIcon = createAppIcon();
  
  // Get the primary display
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  const { x, y } = primaryDisplay.workArea;
  
  // Calculate the position that centers the window on the primary display
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
    show: false, // Always start the app hidden
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Hide the window after it loads
  mainWindow.once('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.hide();
    }
  });

  // Send the loaded alarms to the renderer after the page loads
  mainWindow.webContents.once('did-finish-load', () => {
    sendAlarmsToRenderer();
    sendCountdownWindowState();
  });

  // Hide the window to the tray instead of quitting when it closes
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
  // Start with a dash icon
  tray = new Tray(createTextIcon('—', false));

  updateTrayMenu();
  updateTrayIcon();

  // Left-click the tray icon to show or hide the window
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

  // Double-click the tray icon to show the window
  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
    updateTrayMenu();
  });
}

// Initialize the application
function initializeApp(): void {
  const store = createSettingsStore({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
    overridePath: process.env.ALARM_SETTINGS_PATH,
  });
  settingsStore = store;
  // Load settings at startup
  const settings = store.load();
  alarms = settings.alarms;
  countdownWindowVisiblePref = settings.countdownWindowVisible;
  timezonePref = settings.timezone ?? null;

  createWindow();
  createTray();
  startAlarmChecker();

  if (countdownWindowVisiblePref) {
    createCountdownWindow();
  }

  registerIpcHandlers({
    getAlarms: () => alarms,
    setAlarms: value => { alarms = value; },
    saveSettings,
    updateTrayIcon,
    sendAlarmsToRenderer,
    minimizeWindow: () => { mainWindow?.hide(); updateTrayMenu(); },
    trayClick: () => {
      if (!tray || !mainWindow) return;
      if (mainWindow.isVisible()) mainWindow.hide();
      else { mainWindow.show(); mainWindow.focus(); }
      updateTrayMenu();
    },
    toggleCountdownWindow,
    destroyCountdownWindow,
    stopBlinking,
    getEffectiveTimezone,
    getTimezonePref: () => timezonePref,
    setTimezonePref: value => { timezonePref = value; },
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

// Enforce single-instance mode when enabled
if (ALLOW_ONLY_ONE_INSTANCE) {
  const gotTheLock = app.requestSingleInstanceLock();

  if (!gotTheLock) {
    // Quit if another instance is already running
    app.quit();
  } else {
    // Handle attempts to start a second instance
    app.on('second-instance', () => {
      // Show the existing window when the user starts another instance
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
  // Start without a single-instance lock when multiple instances are allowed
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
  // Keep the app running after all windows close
  // The app continues running in the system tray
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopAlarmChecker();
});

