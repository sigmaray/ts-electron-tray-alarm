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
  notificationMode?: 'window' | 'system' | 'both'; sound?: 'classic' | 'digital' | 'gentle';
}): Promise<void> {
  await page.locator('#addAlarmBtn').click();
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
  if (options.notificationMode) {
    const radioId = `#notification${options.notificationMode[0].toUpperCase()}${options.notificationMode.slice(1)}`;
    await page.locator(radioId).check();
  }
  if (options.message) await page.locator('#alarmOptionsMessage').fill(options.message);
  if (options.withoutSound) await page.locator('#alarmSoundEnabledNo').check();
  if (options.sound) await page.locator('#alarmOptionsSound').selectOption(options.sound);
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

  test('shows a shortened notification message and the correct sound icon in each alarm row', async () => {
    const longMessage = 'A'.repeat(180);
    await addAlarm(window, { hour: '08', minute: '31', date: '2099-12-31', message: longMessage, withoutSound: true });
    await addAlarm(window, { hour: '08', minute: '32', date: '2099-12-31', message: 'Sound on' });

    const mutedRow = window.locator('.alarm-item').filter({ hasText: '08:31:00' });
    const soundRow = window.locator('.alarm-item').filter({ hasText: '08:32:00' });
    const message = mutedRow.locator('.alarm-item__message');
    await expect(message).toContainText(`${'A'.repeat(120)}…`);
    await expect(message).toHaveAttribute('title', longMessage);
    await expect(mutedRow.locator('.alarm-item__sound')).toHaveAttribute('aria-label', 'Muted');
    await expect(mutedRow.locator('.alarm-item__sound i')).toHaveClass(/fa-volume-xmark/);
    await expect(soundRow.locator('.alarm-item__sound')).toHaveAttribute('aria-label', 'Sound enabled');
    await expect(soundRow.locator('.alarm-item__sound i')).toHaveClass(/fa-volume/);
  });

  test('saves every notification mode and sound choice through the alarm form', async () => {
    const cases = [
      { hour: '09', minute: '11', mode: 'window', sound: 'classic' },
      { hour: '09', minute: '12', mode: 'system', sound: 'digital' },
      { hour: '09', minute: '13', mode: 'both', sound: 'gentle' },
    ] as const;
    for (const item of cases) {
      await addAlarm(window, {
        hour: item.hour, minute: item.minute, date: '2099-12-31',
        notificationMode: item.mode, sound: item.sound,
      });
    }

    for (const item of cases) {
      const alarm = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).alarms
        .find((candidate: { hour: number; minute: number }) => candidate.hour === Number(item.hour) && candidate.minute === Number(item.minute));
      expect(alarm).toMatchObject({ notificationMode: item.mode, sound: item.sound });
      const row = window.locator(`.alarm-item[data-id="${alarm.id}"]`);
      await row.getByRole('button', { name: 'Edit' }).click();
      await expect(window.locator(`#notification${item.mode[0].toUpperCase()}${item.mode.slice(1)}`)).toBeChecked();
      await expect(window.locator('#alarmOptionsSound')).toHaveValue(item.sound);
      await window.getByRole('button', { name: 'Cancel' }).click();
    }
  });

  test('system and combined notification modes follow platform support when alarms fire', async () => {
    const supported = await electronApp.evaluate(() => (global as any).__notificationState__().supported);
    for (const mode of ['system', 'both'] as const) {
      const beforeCount = await electronApp.evaluate(() => (global as any).__notificationState__().showCount);
      const target = Date.now() + 3000;
      const targetTime = new Date(target);
      const alarm = {
        id: `notification-${mode}-e2e`, hour: targetTime.getHours(), minute: targetTime.getMinutes(),
        second: targetTime.getSeconds(), enabled: true, recurring: false, frequency: 'once',
        notificationMode: mode, sound: 'none', scheduledAt: target, message: `E2E ${mode} notification`,
      };
      const dialogPromise = mode === 'both' ? electronApp.waitForEvent('window') : null;
      const added = await window.evaluate(async item => (window as any).electronAPI.addAlarm(item), alarm);
      expect(added.ok).toBe(true);
      const alarmDialog = dialogPromise ? await dialogPromise : null;
      if (alarmDialog) {
        await alarmDialog.waitForLoadState('domcontentloaded');
        await expect(alarmDialog.locator('#alarmMessage')).toHaveText(`E2E ${mode} notification`, { timeout: 12000 });
      }
      await expect.poll(() => JSON.parse(fs.readFileSync(settingsPath, 'utf8')).alarms
        .find((item: { id: string }) => item.id === alarm.id)?.completed).toBe(true);
      if (supported) {
        await expect.poll(() => electronApp.evaluate(() => (global as any).__notificationState__().showCount))
          .toBeGreaterThan(beforeCount);
      } else if (mode === 'system') {
        await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
          .find((item: any) => item.webContents.getURL().includes('index.html'))?.isVisible())).toBe(true);
      }
      if (alarmDialog) await alarmDialog.getByRole('button', { name: 'Dismiss' }).click();
      else await window.evaluate(() => (window as any).electronAPI.dismissAlarm());
      await expect.poll(() => electronApp.evaluate(() => (global as any).__trayState__().alarmActive)).toBe(false);
    }
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

  test('a fired daily alarm stays enabled and is scheduled for its next occurrence', async () => {
    const target = Date.now() + 3000;
    const targetDate = new Date(target);
    const alarm = {
      id: 'daily-repeat-e2e', hour: targetDate.getHours(), minute: targetDate.getMinutes(),
      second: targetDate.getSeconds(), enabled: true, recurring: true, frequency: 'daily',
      notificationMode: 'window', sound: 'none', scheduledAt: target,
    };
    const result = await window.evaluate(async item => (window as any).electronAPI.addAlarm(item), alarm);
    expect(result.ok).toBe(true);
    const dialogPromise = electronApp.waitForEvent('window');
    const alarmDialog = await dialogPromise;
    await alarmDialog.waitForLoadState('domcontentloaded');
    await expect(alarmDialog.locator('#alarmMessage')).toContainText('Time:', { timeout: 12000 });
    await expect.poll(() => JSON.parse(fs.readFileSync(settingsPath, 'utf8')).alarms
      .find((item: { id: string }) => item.id === alarm.id)?.scheduledAt).toBeGreaterThan(Date.now() + 60_000);
    const persistedAlarm = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).alarms
      .find((item: { id: string }) => item.id === alarm.id);
    expect(persistedAlarm.enabled).toBe(true);
    expect(persistedAlarm.completed).toBeUndefined();
    await alarmDialog.getByRole('button', { name: 'Dismiss' }).click();
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

  test('a scheduled alarm fires and Dismiss closes it and completes the alarm', async () => {
    const initialImageUpdates = await electronApp.evaluate(() => (global as any).__trayState__().imageUpdates);
    await window.getByRole('button', { name: 'in 5 seconds', exact: true }).click();
    await window.locator('#alarmOptionsMessage').fill('E2E alarm dismissal');
    const dialogPromise = electronApp.waitForEvent('window');
    await window.getByRole('button', { name: 'Save', exact: true }).click();
    const alarmDialog = await dialogPromise;
    await alarmDialog.waitForLoadState('domcontentloaded');
    await expect(alarmDialog.locator('#alarmMessage')).toHaveText('E2E alarm dismissal', { timeout: 12000 });
    await expect.poll(() => electronApp.evaluate(() => (global as any).__trayState__().alarmActive)).toBe(true);
    await expect.poll(() => electronApp.evaluate(() => (global as any).__trayState__().imageUpdates))
      .toBeGreaterThan(initialImageUpdates);
    await expect.poll(() => electronApp.evaluate(() => (global as any).__trayState__().blinking)).toBe(true);
    const blinkingIcon = await electronApp.evaluate(() => (global as any).__trayState__().imageData);
    await expect.poll(() => electronApp.evaluate(() => (global as any).__trayState__().blinking)).toBe(false);
    await expect.poll(() => electronApp.evaluate(() => (global as any).__trayState__().imageData))
      .not.toBe(blinkingIcon);
    const alarmId = new URL(alarmDialog.url()).searchParams.get('alarmId');
    expect(alarmId).toBeTruthy();
    await alarmDialog.getByRole('button', { name: 'Dismiss' }).click();
    await expect.poll(() => alarmDialog.isClosed()).toBe(true);
    await expect.poll(() => JSON.parse(fs.readFileSync(settingsPath, 'utf8')).alarms
      .find((alarm: { id: string }) => alarm.id === alarmId)?.completed).toBe(true);
    await expect.poll(() => electronApp.evaluate(() => (global as any).__trayState__().alarmActive)).toBe(false);
    const stableImageUpdates = await electronApp.evaluate(() => (global as any).__trayState__().imageUpdates);
    const stableTooltipUpdates = await electronApp.evaluate(() => (global as any).__trayState__().tooltipUpdates);
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(await electronApp.evaluate(() => (global as any).__trayState__().imageUpdates)).toBe(stableImageUpdates);
    expect(await electronApp.evaluate(() => (global as any).__trayState__().tooltipUpdates)).toBe(stableTooltipUpdates);
  });

  test('Postpone from a fired alarm schedules it again for the selected delay', async () => {
    await window.getByRole('button', { name: 'in 5 seconds', exact: true }).click();
    await window.locator('#alarmOptionsMessage').fill('E2E alarm postpone');
    const dialogPromise = electronApp.waitForEvent('window');
    await window.getByRole('button', { name: 'Save', exact: true }).click();
    const alarmDialog = await dialogPromise;
    await alarmDialog.waitForLoadState('domcontentloaded');
    await expect(alarmDialog.locator('#alarmMessage')).toHaveText('E2E alarm postpone', { timeout: 12000 });
    const alarmId = new URL(alarmDialog.url()).searchParams.get('alarmId');
    expect(alarmId).toBeTruthy();
    await alarmDialog.locator('#postponeSelect').selectOption('5');
    await alarmDialog.getByRole('button', { name: 'Postpone' }).click();
    await expect.poll(() => alarmDialog.isClosed()).toBe(true);
    await expect.poll(() => JSON.parse(fs.readFileSync(settingsPath, 'utf8')).alarms
      .find((alarm: { id: string }) => alarm.id === alarmId)?.enabled).toBe(true);
    const postponed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).alarms
      .find((alarm: { id: string }) => alarm.id === alarmId);
    expect(postponed.scheduledAt).toBeGreaterThan(Date.now());
    expect(postponed.scheduledAt).toBeLessThanOrEqual(Date.now() + 6000);
    await window.evaluate(async alarm => (window as any).electronAPI.updateAlarm({ ...alarm, enabled: false }), postponed);
  });

  test('rejects an invalid time without creating an alarm', async () => {
    await window.locator('#addAlarmBtn').click();
    await window.locator('#alarmOptionsHour').fill('25');
    const validationDialog = new Promise<string>(resolve => {
      window.once('dialog', async dialog => {
        const message = dialog.message();
        await dialog.accept();
        resolve(message);
      });
    });
    await window.getByRole('button', { name: 'Save', exact: true }).click();
    expect(await validationDialog).toContain('valid hour');
    await expect(window.locator('.alarm-item')).toHaveCount(0);
    await window.getByRole('button', { name: 'Cancel' }).click();
  });

  test('hourly alarms ignore an old date left in the form', async () => {
    await window.locator('#addAlarmBtn').click();
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
    await window.locator('#addAlarmBtn').click();
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

  test('closing a fired alarm window from its title bar dismisses the alarm', async () => {
    await window.getByRole('button', { name: 'in 5 seconds', exact: true }).click();
    await window.locator('#alarmOptionsMessage').fill('Close to dismiss');
    const dialogPromise = electronApp.waitForEvent('window');
    await window.getByRole('button', { name: 'Save', exact: true }).click();
    const alarmDialog = await dialogPromise;
    await alarmDialog.waitForLoadState('domcontentloaded');
    await expect(alarmDialog.locator('#alarmMessage')).toHaveText('Close to dismiss', { timeout: 12000 });
    const alarmId = new URL(alarmDialog.url()).searchParams.get('alarmId');
    await electronApp.evaluate(({ BrowserWindow }, id) => {
      const alarmWindow = BrowserWindow.getAllWindows().find((item: any) =>
        item.webContents.getURL().includes('alarm-dialog.html') && item.webContents.getURL().includes(`alarmId=${id}`));
      alarmWindow?.close();
    }, alarmId);
    await expect.poll(() => alarmDialog.isClosed()).toBe(true);
    await expect.poll(() => JSON.parse(fs.readFileSync(settingsPath, 'utf8')).alarms
      .find((alarm: { id: string }) => alarm.id === alarmId)?.completed).toBe(true);
  });

  test('alarm windows are resizable and long messages can scroll', async () => {
    const longMessage = 'Long alarm message. '.repeat(25);
    await window.getByRole('button', { name: 'in 5 seconds', exact: true }).click();
    await window.locator('#alarmOptionsMessage').fill(longMessage);
    const dialogPromise = electronApp.waitForEvent('window');
    await window.getByRole('button', { name: 'Save', exact: true }).click();
    const alarmDialog = await dialogPromise;
    await alarmDialog.waitForLoadState('domcontentloaded');
    await expect(alarmDialog.locator('#alarmMessage')).toHaveText(longMessage, { timeout: 12000 });
    const alarmId = new URL(alarmDialog.url()).searchParams.get('alarmId');
    const dimensions = await electronApp.evaluate(({ BrowserWindow }, id) => {
      const item = BrowserWindow.getAllWindows().find((candidate: any) =>
        candidate.webContents.getURL().includes('alarm-dialog.html') && candidate.webContents.getURL().includes(`alarmId=${id}`));
      if (!item) return null;
      item.setSize(430, 240);
      return { resizable: item.isResizable() };
    }, alarmId);
    expect(dimensions?.resizable).toBe(true);
    await expect.poll(() => alarmDialog.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true);
    await alarmDialog.close();
  });

  test('preview is resizable, scrolls long messages, and immediately stops its sound when closed', async () => {
    await window.locator('#addAlarmBtn').click();
    await window.locator('#alarmOptionsMessage').fill('Preview message. '.repeat(120));
    await window.evaluate(() => {
      (window as any).__audioCloseCount = 0;
      class FakeAudioContext {
        currentTime = 0;
        destination = {};
        createOscillator() { return { frequency: { value: 0 }, type: '', connect() {}, start() {}, stop() {} }; }
        createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
        close() { (window as any).__audioCloseCount++; return Promise.resolve(); }
      }
      (window as any).AudioContext = FakeAudioContext;
    });
    const previewPromise = electronApp.waitForEvent('window');
    await window.getByRole('button', { name: 'Preview alarm' }).click();
    const previewWindow = await previewPromise;
    await previewWindow.waitForLoadState('domcontentloaded');
    await expect(previewWindow.locator('#alarmMessage')).toContainText('Preview message.');
    const resizable = await electronApp.evaluate(({ BrowserWindow }) => {
      const item = BrowserWindow.getAllWindows().find((candidate: any) => candidate.webContents.getURL().includes('preview=true'));
      if (!item) return false;
      item.setSize(430, 180);
      return item.isResizable();
    });
    expect(resizable).toBe(true);
    await expect.poll(() => previewWindow.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true);
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((candidate: any) => candidate.webContents.getURL().includes('preview=true'))?.close();
    });
    await expect.poll(() => previewWindow.isClosed()).toBe(true);
    await expect.poll(() => window.evaluate(() => (window as any).__audioCloseCount)).toBeGreaterThan(0);
    await window.getByRole('button', { name: 'Cancel' }).click();
  });

  test('settings Apply persists changes without closing the Settings window', async () => {
    const settingsPromise = electronApp.waitForEvent('window');
    await window.getByRole('button', { name: 'Settings' }).click();
    const settingsWindow = await settingsPromise;
    await settingsWindow.waitForLoadState('domcontentloaded');
    for (const format of ['compact', 'clock', 'seconds']) {
      await settingsWindow.locator('#countdownFormat').selectOption(format);
      await settingsWindow.locator('#settingsApply').click();
      await expect(settingsWindow.locator('#settingsStatus')).toHaveText('Settings applied.');
      expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).countdownFormat).toBe(format);
    }
    for (const fontSize of ['8', '32']) {
      await settingsWindow.locator('#countdownFontSize').selectOption(fontSize);
      await settingsWindow.locator('#settingsApply').click();
      await expect(settingsWindow.locator('#settingsStatus')).toHaveText('Settings applied.');
      expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).countdownFontSize).toBe(Number(fontSize));
    }
    await settingsWindow.locator('#settingsTimezone').selectOption('');
    await settingsWindow.locator('#settingsApply').click();
    await expect(settingsWindow.locator('#settingsStatus')).toHaveText('Settings applied.');
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).timezone).toBeNull();

    await settingsWindow.locator('#settingsTimezone').selectOption('Europe/Minsk');
    await settingsWindow.locator('#confirmQuit').uncheck();
    await settingsWindow.locator('#countdownFormat').selectOption('seconds');
    await settingsWindow.locator('#countdownFontSize').selectOption('20');
    await settingsWindow.locator('#countdownMenuButtonVisible').uncheck();
    await settingsWindow.locator('#settingsApply').click();
    await expect(settingsWindow.locator('#settingsStatus')).toHaveText('Settings applied.');
    expect(settingsWindow.isClosed()).toBe(false);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toMatchObject({
      timezone: 'Europe/Minsk', confirmQuit: false, countdownFormat: 'seconds',
      countdownFontSize: 20, countdownMenuButtonVisible: false,
    });
    await settingsWindow.locator('#settingsSave').click();
    await expect.poll(() => settingsWindow.isClosed()).toBe(true);

    const reopenedSettingsPromise = electronApp.waitForEvent('window');
    await window.getByRole('button', { name: 'Settings' }).click();
    const reopenedSettings = await reopenedSettingsPromise;
    await reopenedSettings.waitForLoadState('domcontentloaded');
    await expect(reopenedSettings.locator('#settingsTimezone')).toHaveValue('Europe/Minsk');
    await expect(reopenedSettings.locator('#confirmQuit')).not.toBeChecked();
    await expect(reopenedSettings.locator('#countdownFormat')).toHaveValue('seconds');
    await expect(reopenedSettings.locator('#countdownFontSize')).toHaveValue('20');
    await expect(reopenedSettings.locator('#countdownMenuButtonVisible')).not.toBeChecked();
    await reopenedSettings.locator('#settingsCancel').click();
    await expect.poll(() => reopenedSettings.isClosed()).toBe(true);
  });

  test('tray actions hide and restore the main window', async () => {
    await electronApp.evaluate(({ BrowserWindow }) => {
      const menu = (global as any).__trayMenu__();
      const main = BrowserWindow.getAllWindows().find((item: any) => item.webContents.getURL().includes('index.html'));
      menu.popup({ window: main });
    });
    await expect.poll(() => electronApp.evaluate(() => (global as any).__trayState__().menuOpen)).toBe(true);
    const menuLabels = await electronApp.evaluate(() => {
      const menu = (global as any).__trayMenu__();
      return menu.items.map((item: any) => item.label);
    });
    expect(menuLabels).toContain('New alarm');
    expect(menuLabels).toContain('Hide main window');
    await electronApp.evaluate(() => (global as any).__trayMenu__().closePopup());
    await expect.poll(() => electronApp.evaluate(() => (global as any).__trayState__().menuOpen)).toBe(false);

    await electronApp.evaluate(() => {
      const item = (global as any).__trayMenu__().getMenuItemById('tray-main-window');
      item.click(item, null, {});
    });
    await expect.poll(() => electronApp.evaluate(() => {
      const menu = (global as any).__trayMenu__();
      return menu.getMenuItemById('tray-main-window')?.label;
    })).toBe('Show main window');
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((item: any) => item.webContents.getURL().includes('index.html') && !item.webContents.getURL().includes('alarmDialogOnly'))
      ?.isVisible())).toBe(false);
    await electronApp.evaluate(() => {
      const item = (global as any).__trayMenu__().getMenuItemById('tray-main-window');
      item.click(item, null, {});
    });
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((item: any) => item.webContents.getURL().includes('index.html') && !item.webContents.getURL().includes('alarmDialogOnly'))
      ?.isVisible())).toBe(true);
    await expect.poll(() => electronApp.evaluate(() => {
      const menu = (global as any).__trayMenu__();
      return menu.getMenuItemById('tray-main-window')?.label;
    })).toBe('Hide main window');
  });

  test('alarms and preferences survive an application restart', async () => {
    await window.evaluate(async () => {
      const api = (window as any).electronAPI;
      await api.setTimezone('Europe/Minsk');
      await api.saveAppPreferences({
        confirmQuit: false, countdownFormat: 'seconds', countdownMenuButtonVisible: false, countdownFontSize: 20,
      });
    });
    await addAlarm(window, {
      hour: '08', minute: '45', date: '2099-12-31', message: 'Persist after restart', withoutSound: true,
    });
    const beforeRestart = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(beforeRestart.alarms).toHaveLength(1);
    expect(beforeRestart).toMatchObject({
      timezone: 'Europe/Minsk', confirmQuit: false, countdownFormat: 'seconds',
      countdownFontSize: 20, countdownMenuButtonVisible: false,
    });

    await electronApp.close();
    electronApp = await electron.launch({
      executablePath: require('electron'),
      args: [path.join(__dirname, '../../dist/main.js')],
      env: {
        ...process.env, ELECTRON_DISABLE_SANDBOX: '1', ALLOW_ONLY_ONE_INSTANCE: 'false',
        ALARM_SETTINGS_PATH: settingsPath,
      },
    });
    await expect.poll(() => electronApp.windows().some(page => page.url().includes('index.html'))).toBe(true);
    window = electronApp.windows().find(page => page.url().includes('index.html'))!;
    await window.waitForLoadState('domcontentloaded');
    await window.locator('#alarmsList').waitFor({ state: 'attached' });
    await electronApp.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((item: any) => item.webContents.getURL().includes('index.html'));
      main?.show();
      main?.focus();
    });
    await window.bringToFront();
    const restoredAlarm = window.locator('.alarm-item').filter({ hasText: '08:45:00' });
    await expect(restoredAlarm).toContainText('Persist after restart');
    await expect(restoredAlarm.locator('.alarm-item__sound')).toHaveAttribute('aria-label', 'Muted');

    const afterRestart = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(afterRestart.alarms[0]).toMatchObject({ message: 'Persist after restart', sound: 'none' });
    expect(afterRestart).toMatchObject({
      timezone: 'Europe/Minsk', confirmQuit: false, countdownFormat: 'seconds',
      countdownFontSize: 20, countdownMenuButtonVisible: false,
    });
  });
});
