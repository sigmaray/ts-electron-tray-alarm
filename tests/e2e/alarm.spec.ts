import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const settingsPath = path.join(__dirname, '../../dist/settings.json');

function removeSettings(): void {
  try { fs.unlinkSync(settingsPath); } catch { /* No settings file exists yet. */ }
}

function savedAlarmIds(): string[] {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return Array.isArray(settings.alarms) ? settings.alarms.map((alarm: { id: string }) => alarm.id) : [];
  } catch {
    return [];
  }
}

async function clearAlarms(page: Page): Promise<void> {
  const ids = savedAlarmIds();
  if (ids.length) {
    await page.evaluate(async alarmIds => {
      const api = (window as any).electronAPI;
      await Promise.all(alarmIds.map((id: string) => api.deleteAlarm(id)));
    }, ids);
  }
  await expect(page.locator('.alarm-item')).toHaveCount(0);
}

async function addAlarm(page: Page, options: {
  hour?: string; minute: string; second?: string; frequency?: 'once' | 'daily' | 'hourly';
  date?: string; message?: string; withoutSound?: boolean;
}): Promise<void> {
  await page.getByRole('button', { name: 'Add alarm' }).click();
  const dialog = page.locator('#alarmOptionsOverlay');
  await expect(dialog).toHaveClass(/modal-overlay--visible/);
  const frequency = options.frequency ?? 'once';
  if (frequency !== 'once') await page.locator(`#alarmFrequency${frequency[0].toUpperCase()}${frequency.slice(1)}`).check();
  if (frequency !== 'hourly') await page.locator('#alarmOptionsHour').fill(options.hour ?? '08');
  await page.locator('#alarmOptionsMinute').fill(options.minute);
  if (frequency !== 'hourly') await page.locator('#alarmOptionsSecond').fill(options.second ?? '00');
  if (frequency === 'once' && options.date) {
    await page.getByRole('button', { name: 'Set date' }).click();
    await page.locator('#alarmOptionsDate').fill(options.date);
  }
  if (options.message) await page.locator('#alarmOptionsMessage').fill(options.message);
  if (options.withoutSound) await page.locator('#alarmSoundEnabledNo').check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).not.toHaveClass(/modal-overlay--visible/);
}

test.describe('Alarm application', () => {
  let electronApp: Awaited<ReturnType<typeof electron.launch>>;
  let window: Page;
  let showMainBeforeEach = false;

  test.beforeAll(async () => {
    removeSettings();
    electronApp = await electron.launch({
      executablePath: require('electron'),
      args: [path.join(__dirname, '../../dist/main.js')],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SANDBOX: '1',
        ALARM_SETTINGS_PATH: settingsPath,
      },
    });
    await expect.poll(() => electronApp.windows().some(page => page.url().includes('index.html'))).toBe(true);
    window = electronApp.windows().find(page => page.url().includes('index.html'))!;
    await window.waitForLoadState('domcontentloaded');
    await window.locator('#alarmsList').waitFor({ state: 'attached' });
  });

  test.afterAll(async () => {
    await electronApp?.close();
  });

  test.beforeEach(async () => {
    if (showMainBeforeEach) {
      await electronApp.evaluate(({ BrowserWindow }) => {
        const main = BrowserWindow.getAllWindows().find((item: any) => item.webContents.getURL().includes('index.html'));
        main?.show();
        main?.focus();
      });
      await window.bringToFront();
      await clearAlarms(window);
    }
    showMainBeforeEach = true;
  });

  test('starts with the main window hidden and countdown window visible by default', async () => {
    const initialWindows = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((item: any) => ({
      url: item.webContents.getURL(), visible: item.isVisible(),
    })));
    expect(initialWindows.find(item => item.url.includes('index.html'))?.visible).toBe(false);
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .some((item: any) => item.webContents.getURL().includes('countdown.html') && item.isVisible()))).toBe(true);
    await expect(window.locator('#alarmsList')).toContainText('No alarms set');
  });

  test('adds and edits a dated alarm with its message and sound preference', async () => {
    await addAlarm(window, {
      hour: '08', minute: '30', date: '2099-12-31', message: 'Take medication', withoutSound: true,
    });
    const row = window.locator('.alarm-item').filter({ hasText: '08:30:00' });
    await expect(row).toContainText('2099-12-31');
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).alarms[0].sound).toBe('none');

    await row.getByRole('button', { name: 'Edit' }).click();
    await expect(window.locator('#alarmOptionsMessage')).toHaveValue('Take medication');
    await expect(window.locator('#alarmSoundControls')).toBeHidden();
    await window.locator('#alarmOptionsMessage').fill('Call home');
    await window.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => JSON.parse(fs.readFileSync(settingsPath, 'utf8')).alarms[0].message).toBe('Call home');
  });

  test('groups alarm frequencies and orders hourly alarms by enabled state and minute', async () => {
    await addAlarm(window, { hour: '09', minute: '00', date: '2099-12-31' });
    await addAlarm(window, { hour: '10', minute: '15', frequency: 'daily' });
    await addAlarm(window, { minute: '45', frequency: 'hourly' });
    await addAlarm(window, { minute: '05', frequency: 'hourly' });

    for (const heading of ['Once', 'Daily', 'Every Hour']) {
      await expect(window.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    }
    const hourlyGroup = window.locator('.alarm-list__group').filter({
      has: window.getByRole('heading', { name: 'Every Hour', exact: true }),
    });
    const hourlyRows = hourlyGroup.locator('.alarm-item');
    await expect(hourlyRows).toHaveCount(2);
    await expect(hourlyRows.nth(0).locator('.alarm-item__frequency')).toHaveText('Every hour at minute 05');

    const minuteFiveRow = hourlyRows.nth(0);
    const minuteFiveId = await minuteFiveRow.getAttribute('data-id');
    const minuteFiveToggle = window.locator(`.alarm-item[data-id="${minuteFiveId}"] input[type="checkbox"]`);
    await minuteFiveToggle.uncheck();
    await expect(minuteFiveToggle).not.toBeChecked();
    await expect.poll(() => JSON.parse(fs.readFileSync(settingsPath, 'utf8')).alarms
      .find((alarm: { frequency?: string; minute: number }) => alarm.frequency === 'hourly' && alarm.minute === 5)?.enabled).toBe(false);
    await expect(hourlyGroup.locator('.alarm-item').nth(0).locator('.alarm-item__frequency'))
      .toHaveText('Every hour at minute 45');
  });

  test('quick reminder opens the add-alarm form with a preset time', async () => {
    await window.getByRole('button', { name: 'in 5 seconds', exact: true }).click();
    await expect(window.locator('#alarmOptionsOverlay')).toHaveClass(/modal-overlay--visible/);
    const secondsUntilAlarm = await window.evaluate(async () => {
      const timezone = await (window as any).electronAPI.getCurrentTimezone();
      const date = (document.getElementById('alarmOptionsDate') as HTMLInputElement).value;
      const [year, month, day] = date.split('-').map(Number);
      const timestamp = (window as any).AlarmTime.zonedDateTimeToTimestamp(timezone.effective, {
        year, month, day,
        hour: Number((document.getElementById('alarmOptionsHour') as HTMLInputElement).value),
        minute: Number((document.getElementById('alarmOptionsMinute') as HTMLInputElement).value),
        second: Number((document.getElementById('alarmOptionsSecond') as HTMLInputElement).value),
      });
      return Math.round((timestamp - Date.now()) / 1000);
    });
    expect(secondsUntilAlarm).toBeGreaterThanOrEqual(3);
    expect(secondsUntilAlarm).toBeLessThanOrEqual(5);
    await window.getByRole('button', { name: 'Cancel' }).click();
  });

  test('rejects an invalid time without creating an alarm', async () => {
    await window.getByRole('button', { name: 'Add alarm' }).click();
    await window.locator('#alarmOptionsHour').fill('25');
    await window.evaluate(() => { (window as any).__validationMessage = ''; window.alert = message => { (window as any).__validationMessage = message; }; });
    await window.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => window.evaluate(() => (window as any).__validationMessage)).toContain('valid hour');
    await expect(window.locator('.alarm-item')).toHaveCount(0);
    await window.getByRole('button', { name: 'Cancel' }).click();
  });

  test('hourly alarms ignore an old date left in the form', async () => {
    await window.getByRole('button', { name: 'Add alarm' }).click();
    await expect(window.locator('.quick-time')).toBeVisible();
    await window.getByRole('button', { name: 'Set date' }).click();
    await window.locator('#alarmOptionsDate').fill('2020-01-01');
    await window.locator('#alarmFrequencyHourly').check();
    await expect(window.locator('.quick-time')).toBeHidden();
    await window.locator('#alarmFrequencyOnce').check();
    await expect(window.locator('.quick-time')).toBeVisible();
    await window.locator('#alarmFrequencyHourly').check();
    await expect(window.locator('.quick-time')).toBeHidden();
    await window.locator('#alarmOptionsMinute').fill('17');
    await window.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(window.locator('#alarmOptionsOverlay')).not.toHaveClass(/modal-overlay--visible/);
    await expect(window.locator('.alarm-list__group').filter({
      has: window.getByRole('heading', { name: 'Every Hour', exact: true }),
    }).locator('.alarm-item__frequency')).toHaveText('Every hour at minute 17');
  });

  test('marks completed one-time alarms with a struck-through time and deletes them', async () => {
    await addAlarm(window, { hour: '07', minute: '45', date: '2099-12-31' });
    const alarm = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).alarms[0];
    const result = await window.evaluate(async item => (window as any).electronAPI.updateAlarm({
      ...item, enabled: false, completed: true,
    }), alarm);
    expect(result.ok).toBe(true);
    const row = window.locator(`.alarm-item[data-id="${alarm.id}"]`);
    await expect(row.locator('.alarm-item__time-value del')).toHaveText('07:45:00');
    await window.evaluate(() => { window.confirm = () => true; });
    await row.getByRole('button', { name: 'Delete' }).click();
    await expect(row).toHaveCount(0);
  });

  test('Preview alarm opens a preview whose Postpone button only closes the preview', async () => {
    await window.getByRole('button', { name: 'Add alarm' }).click();
    const previewPromise = electronApp.waitForEvent('window');
    await window.getByRole('button', { name: 'Preview alarm' }).click();
    const previewWindow = await previewPromise;
    await previewWindow.waitForLoadState('domcontentloaded');
    await expect(previewWindow.getByRole('heading', { name: '⏰ Alarm preview' })).toBeVisible();
    try {
      await previewWindow.getByRole('button', { name: 'Postpone' }).click();
    } catch (error) {
      if (!previewWindow.isClosed()) throw error;
    }
    await expect.poll(() => previewWindow.isClosed()).toBe(true);
    await expect(window.locator('#alarmOptionsOverlay')).toHaveClass(/modal-overlay--visible/);
    await expect(window.locator('.alarm-item')).toHaveCount(0);
    await window.getByRole('button', { name: 'Cancel' }).click();
  });

  test('settings Apply persists changes without closing the Settings window', async () => {
    const settingsPromise = electronApp.waitForEvent('window');
    await window.getByRole('button', { name: 'Settings' }).click();
    const settingsWindow = await settingsPromise;
    await settingsWindow.waitForLoadState('domcontentloaded');
    await settingsWindow.locator('#countdownFontSize').selectOption('20');
    await settingsWindow.locator('#settingsApply').click();
    await expect(settingsWindow.locator('#settingsStatus')).toHaveText('Settings applied.');
    expect(settingsWindow.isClosed()).toBe(false);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).countdownFontSize).toBe(20);
    await settingsWindow.locator('#settingsSave').click();
    await expect.poll(() => settingsWindow.isClosed()).toBe(true);
  });

  test('tray actions hide and restore the main window', async () => {
    await window.getByRole('button', { name: 'Minimize to Tray' }).click();
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((item: any) => item.webContents.getURL().includes('index.html') && !item.webContents.getURL().includes('alarmDialogOnly'))
      ?.isVisible())).toBe(false);
    await window.evaluate(() => (window as any).electronAPI.clickTray());
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((item: any) => item.webContents.getURL().includes('index.html') && !item.webContents.getURL().includes('alarmDialogOnly'))
      ?.isVisible())).toBe(true);
  });
});
