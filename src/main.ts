import { app, BrowserWindow, Tray, Menu, nativeImage, dialog, screen, Notification } from 'electron';
import * as path from 'path';
import { createCanvas } from 'canvas';
import {
  Alarm, CountdownWindowPosition, createSettingsStore, normalizeHexColor,
  DEFAULT_TRAY_ICON_COLOR, DEFAULT_COUNTDOWN_BACKGROUND_COLOR, DEFAULT_MAIN_WINDOW_BACKGROUND_COLOR,
} from './settings';
import { registerIpcHandlers } from './ipc-handlers';
import { scheduleAlarm } from './alarm-scheduling';
import { localDateTimeInTimezone, nextAlarmTimestamp, zonedDateTimeToTimestamp } from './time.js';

// Extend the Electron app type with the isQuitting flag
declare global {
  namespace Electron {
    interface App {
      isQuitting?: boolean;
    }
  }
}

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let countdownWindow: BrowserWindow | null = null;
let alarmDialogWindow: BrowserWindow | null = null;
let alarmPreviewWindow: BrowserWindow | null = null;
let alarmCreationWindow: BrowserWindow | null = null;
let activeAlarmDialogId: string | null = null;
let tray: Tray | null = null;
let trayContextMenu: Menu | null = null;
let trayMenuOpen = false;
let lastTrayIconKey: string | null = null;
let lastTrayTooltip: string | null = null;
let lastTrayImageData: string | null = null;
let trayImageUpdateCount = 0;
let trayTooltipUpdateCount = 0;
let systemNotificationShowCount = 0;

// Control whether only one app instance may run
const ALLOW_ONLY_ONE_INSTANCE = process.env.ALLOW_ONLY_ONE_INSTANCE !== 'false';

// Expose the tray for tests in development mode
if (process.env.NODE_ENV === 'test' || process.env.ELECTRON_DISABLE_SANDBOX) {
  (global as any).__tray__ = () => tray;
  (global as any).__trayMenu__ = () => trayContextMenu;
  (global as any).__trayState__ = () => ({
    iconKey: lastTrayIconKey, tooltip: lastTrayTooltip,
    imageUpdates: trayImageUpdateCount, tooltipUpdates: trayTooltipUpdateCount,
    imageData: lastTrayImageData,
    alarmActive: isAlarmActive, blinking: isBlinking, menuOpen: trayMenuOpen,
  });
  (global as any).__notificationState__ = () => ({
    supported: Notification.isSupported(), showCount: systemNotificationShowCount,
  });
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

let countdownWindowVisiblePref = true;
let countdownWindowPosition: CountdownWindowPosition | undefined;
let countdownPositionSaveTimer: NodeJS.Timeout | null = null;
let timezonePref: string | null = null; // null means use the system time zone
let confirmQuitPref = true;
let countdownFormatPref: 'compact' | 'clock' | 'seconds' = 'compact';
let countdownMenuButtonVisiblePref = true;
let countdownFontSizePref = 15;
let trayIconColorPref = DEFAULT_TRAY_ICON_COLOR;
let countdownBackgroundColorPref = DEFAULT_COUNTDOWN_BACKGROUND_COLOR;
let mainWindowBackgroundColorPref = DEFAULT_MAIN_WINDOW_BACKGROUND_COLOR;

function saveSettings(): void {
  settingsStore?.save({
    alarms, countdownWindowVisible: countdownWindowVisiblePref, countdownWindowPosition,
    timezone: timezonePref, confirmQuit: confirmQuitPref, countdownFormat: countdownFormatPref,
    countdownMenuButtonVisible: countdownMenuButtonVisiblePref,
    countdownFontSize: countdownFontSizePref,
    trayIconColor: trayIconColorPref,
    countdownBackgroundColor: countdownBackgroundColorPref,
    mainWindowBackgroundColor: mainWindowBackgroundColorPref,
  });
}

async function requestQuit(): Promise<void> {
  if (confirmQuitPref) {
    const result = await dialog.showMessageBox(mainWindow || null as any, {
      type: 'question', buttons: ['Cancel', 'Close'], defaultId: 0, cancelId: 0,
      title: 'Confirmation', message: 'Are you sure you want to quit the application?',
    });
    if (result.response !== 1) return;
  }
  app.isQuitting = true;
  app.quit();
}

// Save alarms and all other settings to disk
function saveAlarms(): void {
  saveSettings();
}

function openNewAlarmDialog(seconds: number | null): void {
  if (alarmCreationWindow && !alarmCreationWindow.isDestroyed()) {
    alarmCreationWindow.focus();
    return;
  }
  const display = screen.getPrimaryDisplay();
  const width = Math.min(620, display.workArea.width);
  const height = Math.min(820, display.workArea.height);
  alarmCreationWindow = new BrowserWindow({
    width, height,
    x: display.workArea.x + Math.round((display.workArea.width - width) / 2),
    y: display.workArea.y + Math.round((display.workArea.height - height) / 2),
    minWidth: Math.min(500, width), minHeight: Math.min(620, height),
    resizable: true, show: false, title: 'Add alarm',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  });
  const creationWindow = alarmCreationWindow;
  creationWindow.loadFile(path.join(__dirname, 'index.html'), {
    query: { alarmDialogOnly: '1', seconds: seconds === null ? '' : String(seconds) },
  });
  creationWindow.once('ready-to-show', () => { creationWindow.show(); creationWindow.focus(); });
  creationWindow.on('closed', () => { if (alarmCreationWindow === creationWindow) alarmCreationWindow = null; });
}

function buildNewInMenu(): Electron.MenuItemConstructorOptions {
  const shortcuts: Array<{ label: string; seconds: number | null }> = [
    { label: 'Custom', seconds: null },
    { label: '5 seconds', seconds: 5 },
    { label: '10 seconds', seconds: 10 },
    { label: '30 seconds', seconds: 30 },
    { label: '1 minute', seconds: 60 },
    { label: '2 minutes', seconds: 120 },
    { label: '10 minutes', seconds: 600 },
    { label: '30 minutes', seconds: 1800 },
    { label: '1 hour', seconds: 3600 },
    { label: '2 hours', seconds: 7200 },
  ];
  return {
    id: 'tray-new-in',
    label: 'New in',
    submenu: shortcuts.map(item => ({
      label: item.label,
      click: () => openNewAlarmDialog(item.seconds),
    })),
  };
}

function updateTrayMenu(): void {
  if (!tray) return;
  const isVisible = mainWindow?.isVisible() ?? false;
  const toggleLabel = isVisible ? 'Hide main window' : 'Show main window';
  const isCountdownVisible = !!(countdownWindow && !countdownWindow.isDestroyed());

  if (trayContextMenu) {
    const mainWindowItem = trayContextMenu.getMenuItemById('tray-main-window');
    const countdownWindowItem = trayContextMenu.getMenuItemById('tray-countdown-window');
    if (mainWindowItem) mainWindowItem.label = toggleLabel;
    if (countdownWindowItem) countdownWindowItem.checked = isCountdownVisible;
    if (!trayMenuOpen) tray.setContextMenu(trayContextMenu);
    return;
  }

  trayContextMenu = Menu.buildFromTemplate([
    {
      label: 'New alarm',
      click: () => openNewAlarmDialog(null),
    },
    {
      id: 'tray-main-window',
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
        setTimeout(() => {
          trayMenuOpen = false;
          updateTrayMenu();
        }, 100);
      },
    },
    {
      id: 'tray-countdown-window',
      label: 'Show countdown window',
      type: 'checkbox',
      checked: isCountdownVisible,
      click: () => toggleCountdownWindow(),
    },
    {
      label: 'Quit',
      click: () => { void requestQuit(); },
    },
  ]);

  trayContextMenu.on('menu-will-show', () => { trayMenuOpen = true; });
  trayContextMenu.on('menu-will-close', () => {
    trayMenuOpen = false;
    updateTrayMenu();
    updateTrayIcon();
  });
  tray.setContextMenu(trayContextMenu);
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
    // Use the configured tray background color.
    bgColor = trayIconColorPref;
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
  return zonedDateTimeToTimestamp(tz, { year, month, day, hour: alarm.hour, minute: alarm.minute, second: alarm.second });
}

function getTimeUntilAlarm(alarm: Alarm): number {
  const tz = getEffectiveTimezone();
  const now = Date.now();
  return Math.floor((nextAlarmTimestamp(tz, alarm, now) - now) / 1000);
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
  if (seconds <= 0) return 'now';
  const totalMinutes = Math.ceil(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function updateTrayIcon(): void {
  if (!tray || trayMenuOpen) return;
  
  let iconKey: string;
  let iconText: string;
  let iconIsBlinking = false;
  let tooltipText: string;
  
  if (isAlarmActive) {
    // Blink a red icon with an exclamation mark
    iconText = '!';
    iconIsBlinking = isBlinking;
    iconKey = `alarm:${isBlinking}:${trayIconColorPref}`;
    tooltipText = '⏰ Alarm!';
  } else {
    const nearestAlarm = getNearestAlarm();
    
    if (nearestAlarm) {
      const timeUntil = getTimeUntilAlarm(nearestAlarm);
      const text = formatTimeForTray(timeUntil);
      iconText = text;
      iconKey = `countdown:${text}:${trayIconColorPref}`;
      
      const alarmTime = `${String(nearestAlarm.hour).padStart(2, '0')}:${String(nearestAlarm.minute).padStart(2, '0')}:${String(nearestAlarm.second).padStart(2, '0')}`;
      tooltipText = `Alarm: ${alarmTime} (in ${formatTimeForTooltip(timeUntil)})`;
    } else {
      iconText = '—';
      iconKey = `empty:${trayIconColorPref}`;
      tooltipText = 'No alarm set';
    }
  }

  if (iconKey !== lastTrayIconKey) {
    const image = createTextIcon(iconText, iconIsBlinking);
    tray.setImage(image);
    lastTrayIconKey = iconKey;
    lastTrayImageData = image.toDataURL();
    trayImageUpdateCount++;
  }
  if (tooltipText !== lastTrayTooltip) {
    tray.setToolTip(tooltipText);
    lastTrayTooltip = tooltipText;
    trayTooltipUpdateCount++;
  }
}

function formatTimeForCountdownWindow(seconds: number): string {
  const remaining = Math.max(0, Math.floor(seconds));
  if (countdownFormatPref === 'seconds') return `${remaining}s`;
  if (countdownFormatPref === 'clock') {
    const hours = Math.floor(remaining / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    const secs = remaining % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  if (remaining < 60) return '< 1m';
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
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

function setCountdownFormat(format: 'compact' | 'clock' | 'seconds'): void {
  countdownFormatPref = format;
  saveSettings();
  updateCountdownWindow();
}

function setCountdownMenuButtonVisible(visible: boolean): void {
  countdownMenuButtonVisiblePref = visible;
  saveSettings();
  if (countdownWindow && !countdownWindow.isDestroyed()) {
    countdownWindow.webContents.send('countdown-menu-button-visibility', visible);
  }
}

function showCountdownWindowMenu(): void {
  if (!countdownWindow || countdownWindow.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    buildNewInMenu(),
    { type: 'separator' },
    { label: 'Remaining time format', enabled: false },
    {
      label: 'Minutes (2m, 1m, < 1m)', type: 'radio', checked: countdownFormatPref === 'compact',
      click: () => setCountdownFormat('compact'),
    },
    {
      label: 'Time with seconds (00:01:51)', type: 'radio', checked: countdownFormatPref === 'clock',
      click: () => setCountdownFormat('clock'),
    },
    {
      label: 'Total seconds (111s)', type: 'radio', checked: countdownFormatPref === 'seconds',
      click: () => setCountdownFormat('seconds'),
    },
    { type: 'separator' },
    {
      label: 'Show menu button', type: 'checkbox', checked: countdownMenuButtonVisiblePref,
      click: menuItem => setCountdownMenuButtonVisible(menuItem.checked),
    },
    { type: 'separator' },
    {
      label: 'Show main window',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
        updateTrayMenu();
      },
    },
    { label: 'Hide countdown window', click: destroyCountdownWindow },
  ]);
  menu.popup({ window: countdownWindow });
}

let COUNTDOWN_WINDOW_WIDTH = 280;
let COUNTDOWN_WINDOW_HEIGHT = 70;

function standardCountdownWindowPosition(display: Electron.Display = screen.getPrimaryDisplay()): CountdownWindowPosition {
  const { x, y, width, height } = display.workArea;
  return {
    displayId: String(display.id),
    displayLabel: display.label,
    displayBounds: { ...display.bounds },
    x: x + Math.max(0, width - COUNTDOWN_WINDOW_WIDTH),
    y: y + Math.max(0, height - COUNTDOWN_WINDOW_HEIGHT),
  };
}

function countdownPositionFits(position: CountdownWindowPosition, display: Electron.Display): boolean {
  const area = display.workArea;
  return position.x >= area.x && position.y >= area.y
    && position.x + COUNTDOWN_WINDOW_WIDTH <= area.x + area.width
    && position.y + COUNTDOWN_WINDOW_HEIGHT <= area.y + area.height;
}

function rememberCountdownWindowPosition(): void {
  if (!countdownWindow || countdownWindow.isDestroyed()) return;
  const bounds = countdownWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  countdownWindowPosition = {
    displayId: String(display.id),
    displayLabel: display.label,
    displayBounds: { ...display.bounds },
    x: bounds.x,
    y: bounds.y,
  };
}

function saveCountdownWindowPositionNow(): void {
  if (countdownPositionSaveTimer) clearTimeout(countdownPositionSaveTimer);
  countdownPositionSaveTimer = null;
  rememberCountdownWindowPosition();
  console.info(`[countdown] Persisting position ${JSON.stringify(countdownWindowPosition)} to ${settingsStore?.getPath() ?? 'settings store unavailable'}`);
  saveSettings();
}

function scheduleCountdownWindowPositionSave(): void {
  if (countdownWindow && !countdownWindow.isDestroyed()) {
    console.info(`[countdown] Window move/resize event at ${JSON.stringify(countdownWindow.getBounds())}`);
  }
  if (countdownPositionSaveTimer) clearTimeout(countdownPositionSaveTimer);
  countdownPositionSaveTimer = setTimeout(() => {
    countdownPositionSaveTimer = null;
    rememberCountdownWindowPosition();
    console.info(`[countdown] Persisting moved position ${JSON.stringify(countdownWindowPosition)} to ${settingsStore?.getPath() ?? 'settings store unavailable'}`);
    saveSettings();
  }, 250);
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

  const displays = screen.getAllDisplays();
  const savedPosition = countdownWindowPosition;
  console.info(`[countdown] Restore attempt from ${settingsStore?.getPath() ?? 'settings store unavailable'}: saved=${JSON.stringify(savedPosition)}, connected displays=${JSON.stringify(displays.map(display => ({ id: display.id, label: display.label, bounds: display.bounds, workArea: display.workArea })))}`);
  let savedDisplay = savedPosition
    ? displays.find(display => String(display.id) === savedPosition.displayId)
    : undefined;
  if (!savedDisplay && savedPosition?.displayLabel) {
    const labelMatches = displays.filter(display => display.label === savedPosition.displayLabel);
    if (labelMatches.length === 1) savedDisplay = labelMatches[0];
  }
  if (!savedDisplay && savedPosition?.displayBounds) {
    const savedBounds = savedPosition.displayBounds;
    const geometryMatches = displays.filter(display => display.bounds.x === savedBounds.x
      && display.bounds.y === savedBounds.y
      && display.bounds.width === savedBounds.width
      && display.bounds.height === savedBounds.height);
    if (geometryMatches.length === 1) savedDisplay = geometryMatches[0];
  }
  const candidate = savedPosition && savedDisplay
    ? { ...savedPosition, displayId: String(savedDisplay.id), displayLabel: savedDisplay.label }
    : undefined;
  const canRestore = !!(candidate && savedDisplay && countdownPositionFits(candidate, savedDisplay));
  const restoredPosition = canRestore && candidate
    ? candidate
    : standardCountdownWindowPosition();
  const restoreReason = canRestore
    ? 'saved monitor is connected and position fits its work area'
    : !savedPosition
      ? 'no saved position; using the standard primary-display position'
      : !savedDisplay
        ? 'saved monitor is unavailable; using the standard primary-display position'
        : 'saved position does not fit the monitor work area; using the standard primary-display position';
  console.info(`[countdown] Restore decision: ${restoreReason}; selected=${JSON.stringify(restoredPosition)}`);
  const positionChanged = !countdownWindowPosition
    || countdownWindowPosition.displayId !== restoredPosition.displayId
    || countdownWindowPosition.x !== restoredPosition.x
    || countdownWindowPosition.y !== restoredPosition.y;
  countdownWindowPosition = restoredPosition;

  countdownWindow = new BrowserWindow({
    width: COUNTDOWN_WINDOW_WIDTH,
    height: COUNTDOWN_WINDOW_HEIGHT,
    x: restoredPosition.x,
    y: restoredPosition.y,
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

  countdownWindow.on('move', scheduleCountdownWindowPositionSave);
  countdownWindow.on('moved', scheduleCountdownWindowPositionSave);
  countdownWindow.on('resize', scheduleCountdownWindowPositionSave);
  if (positionChanged) saveSettings();

  countdownWindow.loadFile(path.join(__dirname, 'countdown.html'));

  countdownWindow.once('ready-to-show', () => {
    if (countdownWindow) {
      updateCountdownWindow();
      countdownWindow.show();
      // Some window managers ignore constructor coordinates until the native window is shown.
      countdownWindow.setPosition(restoredPosition.x, restoredPosition.y);
      const requestedPosition = { x: restoredPosition.x, y: restoredPosition.y };
      setTimeout(() => {
        if (!countdownWindow || countdownWindow.isDestroyed()) return;
        const actualBounds = countdownWindow.getBounds();
        const applied = actualBounds.x === requestedPosition.x && actualBounds.y === requestedPosition.y;
        console.info(`[countdown] Position restore ${applied ? 'applied' : 'not applied by window manager'}: requested=${JSON.stringify(requestedPosition)}, actual=${JSON.stringify(actualBounds)}`);
        rememberCountdownWindowPosition();
        console.info(`[countdown] Persisting post-show position ${JSON.stringify(countdownWindowPosition)} to ${settingsStore?.getPath() ?? 'settings store unavailable'}`);
        saveSettings();
      }, 150);
      console.info(`[countdown] Window shown at ${JSON.stringify(countdownWindow.getBounds())}`);
      countdownWindowVisiblePref = true;
      countdownWindow.webContents.send('countdown-menu-button-visibility', countdownMenuButtonVisiblePref);
      countdownWindow.webContents.send('countdown-font-size', countdownFontSizePref);
      countdownWindow.webContents.send('countdown-background-color', countdownBackgroundColorPref);
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
    saveCountdownWindowPositionNow();
    countdownWindow.close();
    countdownWindow = null;
  }
  countdownWindowVisiblePref = false;
  saveSettings();
  sendCountdownWindowState();
}

function resizeCountdownWindow(width: number, height: number): void {
  if (!countdownWindow || countdownWindow.isDestroyed()) return;
  if (countdownWindow.getContentSize()[0] === width && countdownWindow.getContentSize()[1] === height) return;
  COUNTDOWN_WINDOW_WIDTH = width;
  COUNTDOWN_WINDOW_HEIGHT = height;
  countdownWindow.setContentSize(width, height);
  rememberCountdownWindowPosition();
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
  if (alarmDialogWindow && !alarmDialogWindow.isDestroyed()) alarmDialogWindow.destroy();
  alarmDialogWindow = null;
  activeAlarmDialogId = null;
  updateTrayIcon();
}

function checkAlarms(): void {
  const tz = getEffectiveTimezone();
  const local = localDateTimeInTimezone(tz, Date.now());
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
    const frequency = alarm.frequency ?? (alarm.recurring ? 'daily' : 'once');
    if (frequency === 'daily' && triggeredAlarmsToday.has(alarm.id)) continue;

    const fireTs = alarm.scheduledAt ?? getAlarmTimestampOnCalendarDay(alarm, tz, local.year, local.month, local.day);
    // Fire if the target time has passed, even after an event loop delay or system sleep
    if (nowMs < fireTs) continue;

    triggerAlarm(alarm);

    if (frequency !== 'once') {
      if (frequency === 'daily') triggeredAlarmsToday.add(alarm.id);
      alarm.scheduledAt = nextAlarmTimestamp(tz, { ...alarm, scheduledAt: undefined }, nowMs);
      const nextLocal = localDateTimeInTimezone(tz, alarm.scheduledAt);
      alarm.scheduledDate = `${nextLocal.year}-${String(nextLocal.month).padStart(2, '0')}-${String(nextLocal.day).padStart(2, '0')}`;
      delete alarm.completed;
      saveAlarms();
      sendAlarmsToRenderer();
    } else {
      const firedLocal = localDateTimeInTimezone(tz, fireTs);
      alarm.scheduledDate = `${firedLocal.year}-${String(firedLocal.month).padStart(2, '0')}-${String(firedLocal.day).padStart(2, '0')}`;
      delete alarm.scheduledAt;
      alarm.completed = true;
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
  
  const notificationMode = alarm.notificationMode ?? 'window';
  if (notificationMode === 'window' || notificationMode === 'both') {
    const primaryDisplay = screen.getPrimaryDisplay();
    const dialogWidth = 430;
    const dialogHeight = 300;
    const { x: workAreaX, y: workAreaY, width: workAreaWidth, height: workAreaHeight } = primaryDisplay.workArea;
    const previousDialog = alarmDialogWindow;
    alarmDialogWindow = null;
    activeAlarmDialogId = null;
    if (previousDialog && !previousDialog.isDestroyed()) previousDialog.destroy();
    activeAlarmDialogId = alarm.id;
    const dialogWindow = new BrowserWindow({
      width: dialogWidth, height: dialogHeight,
      x: workAreaX + Math.round((workAreaWidth - dialogWidth) / 2),
      y: workAreaY + Math.round((workAreaHeight - dialogHeight) / 2),
      alwaysOnTop: true, resizable: true, closable: true,
      minWidth: dialogWidth, minHeight: 240,
      show: false, title: 'Alarm',
      webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    });
    alarmDialogWindow = dialogWindow;
    dialogWindow.loadFile(path.join(__dirname, 'alarm-dialog.html'), { query: {
      alarmId: alarm.id, message: alarm.message?.trim() || `Time: ${String(alarm.hour).padStart(2, '0')}:${String(alarm.minute).padStart(2, '0')}`,
      postpone: '300',
    } });
    dialogWindow.once('ready-to-show', () => { if (!dialogWindow.isDestroyed()) dialogWindow.show(); });
    dialogWindow.on('closed', () => {
      const wasActiveDialog = alarmDialogWindow === dialogWindow && activeAlarmDialogId === alarm.id;
      if (alarmDialogWindow === dialogWindow) {
        alarmDialogWindow = null;
        activeAlarmDialogId = null;
      }
      if (wasActiveDialog) {
        stopBlinking();
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('alarm-dismiss-from-main');
      }
    });
  }
  if ((notificationMode === 'system' || notificationMode === 'both') && Notification.isSupported()) {
    const notification = new Notification({
      title: '⏰ Alarm!',
      body: alarm.message?.trim() || `Time: ${String(alarm.hour).padStart(2, '0')}:${String(alarm.minute).padStart(2, '0')}:${String(alarm.second).padStart(2, '0')}`,
      urgency: 'critical',
    });
    
    notification.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
    if (process.env.NODE_ENV === 'test' || process.env.ELECTRON_DISABLE_SANDBOX) systemNotificationShowCount++;
    notification.show();
  } else if (notificationMode === 'system') {
    mainWindow?.show();
    mainWindow?.focus();
  }
  
  // Send an event to the renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('alarm-triggered', alarm.id);
  }
}

function previewAlarm(options: { notificationMode: 'window' | 'system' | 'both'; message?: string; sound: 'classic' | 'digital' | 'gentle' | 'none'; hour: number; minute: number; second: number }): void {
  const body = options.message?.trim() || `Time: ${String(options.hour).padStart(2, '0')}:${String(options.minute).padStart(2, '0')}:${String(options.second).padStart(2, '0')}`;
  if (options.notificationMode === 'window' || options.notificationMode === 'both') {
    if (alarmPreviewWindow && !alarmPreviewWindow.isDestroyed()) alarmPreviewWindow.close();
    const display = screen.getPrimaryDisplay();
    const width = 430;
    const height = 300;
    alarmPreviewWindow = new BrowserWindow({
      width, height,
      x: display.workArea.x + Math.round((display.workArea.width - width) / 2),
      y: display.workArea.y + Math.round((display.workArea.height - height) / 2),
      alwaysOnTop: true, resizable: true, show: false, title: 'Alarm preview',
      webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    });
    const previewWindow = alarmPreviewWindow;
    previewWindow.loadFile(path.join(__dirname, 'alarm-dialog.html'), { query: { message: body, preview: 'true' } });
    previewWindow.once('ready-to-show', () => previewWindow.show());
    previewWindow.on('closed', () => {
      if (alarmPreviewWindow === previewWindow) alarmPreviewWindow = null;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('alarm-preview-closed');
    });
    setTimeout(() => { if (!previewWindow.isDestroyed()) previewWindow.close(); }, 7000);
  }
  if ((options.notificationMode === 'system' || options.notificationMode === 'both') && Notification.isSupported()) {
    new Notification({ title: '⏰ Alarm preview', body, urgency: 'critical' }).show();
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
    mainWindow?.webContents.send('app-colors-updated', {
      mainWindowBackgroundColor: mainWindowBackgroundColorPref,
      countdownBackgroundColor: countdownBackgroundColorPref,
    });
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

function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const settingsWidth = 560;
  const settingsHeight = Math.min(792, primaryWorkArea.height);
  settingsWindow = new BrowserWindow({
    width: settingsWidth,
    height: settingsHeight,
    x: primaryWorkArea.x + Math.round((primaryWorkArea.width - settingsWidth) / 2),
    y: primaryWorkArea.y + Math.round((primaryWorkArea.height - settingsHeight) / 2),
    resizable: true,
    show: false,
    title: 'Settings',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.once('ready-to-show', () => {
    settingsWindow?.show();
    settingsWindow?.setPosition(
      primaryWorkArea.x + Math.round((primaryWorkArea.width - settingsWidth) / 2),
      primaryWorkArea.y + Math.round((primaryWorkArea.height - settingsHeight) / 2),
    );
  });
  settingsWindow.on('closed', () => { settingsWindow = null; });
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
  countdownWindowVisiblePref = settings.countdownWindowVisible;
  countdownWindowPosition = settings.countdownWindowPosition;
  timezonePref = settings.timezone ?? null;
  confirmQuitPref = settings.confirmQuit ?? true;
  countdownFormatPref = settings.countdownFormat ?? 'compact';
  countdownMenuButtonVisiblePref = settings.countdownMenuButtonVisible ?? true;
  countdownFontSizePref = settings.countdownFontSize ?? 15;
  trayIconColorPref = settings.trayIconColor ?? DEFAULT_TRAY_ICON_COLOR;
  countdownBackgroundColorPref = settings.countdownBackgroundColor ?? DEFAULT_COUNTDOWN_BACKGROUND_COLOR;
  mainWindowBackgroundColorPref = settings.mainWindowBackgroundColor ?? DEFAULT_MAIN_WINDOW_BACKGROUND_COLOR;
  const now = Date.now();
  alarms = settings.alarms.map(alarm => scheduleAlarm(alarm, getEffectiveTimezone(), now));
  if (alarms.some((alarm, index) => alarm.scheduledAt !== settings.alarms[index].scheduledAt)) saveSettings();

  createWindow();
  createTray();
  startAlarmChecker();

  if (countdownWindowVisiblePref) {
    createCountdownWindow();
  }

  screen.on('display-removed', () => {
    setTimeout(() => {
      if (!countdownWindow || countdownWindow.isDestroyed()) return;
      const bounds = countdownWindow.getBounds();
      const display = screen.getDisplayMatching(bounds);
      if (!countdownPositionFits({ displayId: String(display.id), x: bounds.x, y: bounds.y }, display)) {
        const fallback = standardCountdownWindowPosition();
        countdownWindow.setPosition(fallback.x, fallback.y);
      }
      saveCountdownWindowPositionNow();
    }, 0);
  });

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
    showCountdownWindowMenu,
    resizeCountdownWindow,
    stopBlinking,
    notifyAlarmDismissed: () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('alarm-dismiss-from-main');
    },
    openSettingsWindow,
    requestQuit: () => { void requestQuit(); },
    getAppPreferences: () => ({
      confirmQuit: confirmQuitPref,
      countdownFormat: countdownFormatPref,
      countdownMenuButtonVisible: countdownMenuButtonVisiblePref,
      countdownFontSize: countdownFontSizePref,
      trayIconColor: trayIconColorPref,
      countdownBackgroundColor: countdownBackgroundColorPref,
      mainWindowBackgroundColor: mainWindowBackgroundColorPref,
    }),
    saveAppPreferences: value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'Invalid settings.' };
      const candidate = value as Record<string, unknown>;
      if (typeof candidate.confirmQuit !== 'boolean'
        || (candidate.countdownFormat !== 'compact' && candidate.countdownFormat !== 'clock' && candidate.countdownFormat !== 'seconds')
        || typeof candidate.countdownMenuButtonVisible !== 'boolean'
        || !Number.isInteger(candidate.countdownFontSize) || Number(candidate.countdownFontSize) < 8 || Number(candidate.countdownFontSize) > 32
        || (candidate.trayIconColor !== undefined && !normalizeHexColor(candidate.trayIconColor))
        || (candidate.countdownBackgroundColor !== undefined && !normalizeHexColor(candidate.countdownBackgroundColor))
        || (candidate.mainWindowBackgroundColor !== undefined && !normalizeHexColor(candidate.mainWindowBackgroundColor))) {
        return { ok: false, error: 'Invalid settings.' };
      }
      confirmQuitPref = candidate.confirmQuit;
      countdownFormatPref = candidate.countdownFormat;
      countdownMenuButtonVisiblePref = candidate.countdownMenuButtonVisible;
      countdownFontSizePref = Number(candidate.countdownFontSize);
      trayIconColorPref = normalizeHexColor(candidate.trayIconColor) ?? trayIconColorPref;
      countdownBackgroundColorPref = normalizeHexColor(candidate.countdownBackgroundColor) ?? countdownBackgroundColorPref;
      mainWindowBackgroundColorPref = normalizeHexColor(candidate.mainWindowBackgroundColor) ?? mainWindowBackgroundColorPref;
      saveSettings();
      updateTrayIcon();
      updateCountdownWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app-colors-updated', {
          mainWindowBackgroundColor: mainWindowBackgroundColorPref,
          countdownBackgroundColor: countdownBackgroundColorPref,
        });
      }
      if (countdownWindow && !countdownWindow.isDestroyed()) {
        countdownWindow.webContents.send('countdown-menu-button-visibility', countdownMenuButtonVisiblePref);
        countdownWindow.webContents.send('countdown-font-size', countdownFontSizePref);
        countdownWindow.webContents.send('countdown-background-color', countdownBackgroundColorPref);
      }
      return { ok: true };
    },
    notifyTimezoneUpdated: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('timezone-updated', { effective: getEffectiveTimezone(), isSystem: timezonePref === null });
      }
    },
    postponeAlarm: (alarmId, delaySeconds) => {
      if (alarmId !== activeAlarmDialogId || !Number.isInteger(delaySeconds) || delaySeconds < 5 || delaySeconds > 1800) return { ok: false, error: 'Invalid postpone request.' };
      const alarm = alarms.find(item => item.id === alarmId);
      if (!alarm) return { ok: false, error: 'Alarm no longer exists.' };
      const scheduledAt = Date.now() + delaySeconds * 1000;
      const local = localDateTimeInTimezone(getEffectiveTimezone(), scheduledAt);
      alarm.enabled = true;
      alarm.completed = undefined;
      alarm.scheduledAt = scheduledAt;
      alarm.scheduledDate = `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
      saveAlarms();
      stopBlinking();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('alarm-dismiss-from-main');
      sendAlarmsToRenderer();
      updateTrayIcon();
      return { ok: true };
    },
    previewAlarm,
    closeAlarmPreview: () => {
      if (alarmPreviewWindow && !alarmPreviewWindow.isDestroyed()) alarmPreviewWindow.close();
    },
    closeAlarmCreationWindow: () => {
      if (alarmCreationWindow && !alarmCreationWindow.isDestroyed()) alarmCreationWindow.close();
    },
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
  if (countdownWindow && !countdownWindow.isDestroyed()) saveCountdownWindowPositionNow();
  app.isQuitting = true;
  stopAlarmChecker();
});

