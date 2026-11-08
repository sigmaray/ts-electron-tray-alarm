import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/** The E2E app uses an isolated settings file so alarms do not leak between runs. */
function removeDistSettings(): void {
  const settingsPath = path.join(__dirname, '../../dist/settings.json');
  try {
    fs.unlinkSync(settingsPath);
  } catch {
    // It is fine if the file does not exist.
  }
}

test.describe('Alarm Application', () => {
  let electronApp: any;
  let window: any;

  test.beforeAll(async () => {
    removeDistSettings();

    // Launch the actual Electron application.
    const electronPath = require('electron');
    const mainPath = path.join(__dirname, '../../dist/main.js');
    
    electronApp = await electron.launch({
      executablePath: electronPath,
      args: [mainPath],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SANDBOX: '1',
        // Keep E2E persistence isolated from the user's real application settings.
        ALARM_SETTINGS_PATH: path.join(__dirname, '../../dist/settings.json'),
      },
    });

    // Get the first application window.
    window = await electronApp.firstWindow();
    
    // Wait for the application to load.
    await window.waitForLoadState('domcontentloaded');
    
    // The app starts hidden in the tray, so show its window for the tests.
    await electronApp.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        windows[0].show();
      }
    });
    
    // Wait for the main elements to appear.
    await window.waitForSelector('#newHour', { timeout: 10000 });
    await window.waitForSelector('#alarmsList', { timeout: 10000 });
    
    // Wait for the application to initialize.
    await window.waitForTimeout(1000);
  });

  test.afterAll(async () => {
    // Close the Electron application after the tests.
    if (electronApp) {
      await electronApp.close();
    }
  });

  test.beforeEach(async () => {
    // Ensure the window is visible before each test.
    if (window) {
      // Show the window explicitly because the app starts hidden in the tray.
      await electronApp.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
          windows[0].show();
          windows[0].focus();
        }
      });
      await window.waitForTimeout(200);
      await window.bringToFront();
    }
  });

  test('shows the initial state', async () => {
    // Check that the time inputs are present.
    await expect(window.locator('#newHour')).toBeVisible();
    await expect(window.locator('#newMinute')).toBeVisible();
    await expect(window.locator('#newSecond')).toBeVisible();
    await expect(window.locator('#addAlarmBtn')).toBeVisible();
    
    // Check that the alarm list is empty.
    const alarmsList = window.locator('#alarmsList');
    await expect(alarmsList).toContainText('No alarms set');
  });

  test('adds a new alarm', async () => {
    // Set the time to 14:30:00.
    await window.fill('#newHour', '14');
    await window.fill('#newMinute', '30');
    await window.fill('#newSecond', '00');
    
    // Add an alarm.
    await window.click('#addAlarmBtn');
    
    // Wait for the UI to update.
    await window.waitForTimeout(500);
    
    // Check that the alarm appears in the list.
    const alarmsList = window.locator('#alarmsList');
    await expect(alarmsList).toContainText('14:30:00');
    await expect(alarmsList).not.toContainText('No alarms set');
  });

  test('sets a scheduled date and notification text from alarm options', async () => {
    await window.fill('#newHour', '06');
    await window.fill('#newMinute', '31');
    await window.fill('#newSecond', '00');
    await window.click('#newAlarmOptionsBtn');
    await expect(window.locator('#alarmOptionsOverlay')).toHaveClass(/modal-overlay--visible/);
    await expect(window.locator('#alarmOptionsHour')).toHaveValue('06');
    await expect(window.locator('#alarmOptionsMinute')).toHaveValue('31');
    await expect(window.locator('#alarmOptionsRecurring')).not.toBeChecked();
    await window.fill('#alarmOptionsDate', '2099-12-31');
    await window.fill('#alarmOptionsMessage', 'Take your medicine');
    await window.click('#alarmOptionsSaveBtn');

    const alarmRow = window.locator('.alarm-item:has-text("2099-12-31")');
    await expect(alarmRow).toContainText('2099-12-31');
    await expect(window.locator('#newHour')).toHaveValue('00');
    await expect(window.locator('#newMinute')).toHaveValue('00');
    await expect(window.locator('#newSecond')).toHaveValue('00');
    await expect(window.locator('#newRecurring')).not.toBeChecked();
    await window.fill('#newHour', '06');
    await window.fill('#newMinute', '31');
    await window.fill('#newSecond', '00');
    await window.click('#newAlarmOptionsBtn');
    await window.fill('#alarmOptionsDate', '2099-12-30');
    await window.fill('#alarmOptionsMessage', 'Second date');
    await window.click('#alarmOptionsSaveBtn');
    await expect(window.locator('.alarm-item:has-text("06:31:00")')).toHaveCount(2);

    await alarmRow.locator('.alarm-actions__options').click();
    await expect(window.locator('#alarmOptionsHour')).toHaveValue('06');
    await expect(window.locator('#alarmOptionsMinute')).toHaveValue('31');
    await expect(window.locator('#alarmOptionsMessage')).toHaveValue('Take your medicine');
    await window.fill('#alarmOptionsMessage', 'Call home');
    await window.click('#alarmOptionsSaveBtn');
    await expect.poll(() => {
      const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '../../dist/settings.json'), 'utf8'));
      return settings.alarms.find((alarm: { hour: number; minute: number; scheduledDate: string }) => alarm.hour === 6 && alarm.minute === 31 && alarm.scheduledDate === '2099-12-31');
    }).toMatchObject({ message: 'Call home', recurring: false });

    const originalTimezone = await window.evaluate(() => (window as any).electronAPI.getCurrentTimezone());
    const alternateTimezone = originalTimezone.effective === 'Asia/Tokyo' ? 'America/New_York' : 'Asia/Tokyo';
    const originalTimestamp = JSON.parse(fs.readFileSync(path.join(__dirname, '../../dist/settings.json'), 'utf8'))
      .alarms.find((alarm: { scheduledDate: string }) => alarm.scheduledDate === '2099-12-31').scheduledAt;
    try {
      await window.click('#timezoneBtn');
      await window.locator('#timezoneList').selectOption(alternateTimezone);
      await window.click('#timezoneSaveBtn');
      await expect.poll(() => {
        const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '../../dist/settings.json'), 'utf8'));
        return settings.alarms.find((alarm: { scheduledDate: string }) => alarm.scheduledDate === '2099-12-31')?.scheduledAt;
      }).not.toBe(originalTimestamp);
    } finally {
      await window.click('#timezoneBtn');
      await window.locator('#timezoneList').selectOption(originalTimezone.isSystem ? '' : originalTimezone.effective);
      await window.click('#timezoneSaveBtn');
    }

    const rejectedCreate = await window.evaluate(async () => (window as any).electronAPI.addAlarm({
      id: 'alarm-duplicate-test', hour: 6, minute: 31, second: 0,
      enabled: true, recurring: false, scheduledDate: '2099-12-31',
      scheduledAt: Date.parse('2099-12-31T06:31:00.000Z'),
    }));
    expect(rejectedCreate).toMatchObject({ ok: false, error: expect.stringContaining('already exists') });
  });

  test('keeps alarm sound active before browser notification permission resolves', async () => {
    await window.evaluate(() => {
      (window as any).__originalAudioContext = window.AudioContext;
      (window as any).__originalNotification = window.Notification;
      class StubGain {
        gain = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
        connect() {}
      }
      class StubOscillator {
        frequency = { value: 0 };
        type = '';
        connect() {}
        start() { (window as any).__beepCount = ((window as any).__beepCount ?? 0) + 1; }
        stop() {}
      }
      class StubAudioContext {
        currentTime = 0;
        destination = {};
        createOscillator() { return new StubOscillator(); }
        createGain() { return new StubGain(); }
        close() { return Promise.resolve(); }
      }
      class DelayedNotification {
        static permission = 'default';
        static requestPermission() { return new Promise<NotificationPermission>(() => {}); }
      }
      Object.defineProperty(window, 'AudioContext', { configurable: true, value: StubAudioContext });
      Object.defineProperty(window, 'Notification', { configurable: true, value: DelayedNotification });
      (window as any).__beepCount = 0;
    });

    const scheduledAt = Date.now() + 1500;
    const alarmTime = await window.evaluate(() => {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(Date.now() + 1500));
      const get = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);
      return { hour: get('hour'), minute: get('minute'), second: get('second') };
    });
    const created = await window.evaluate(async ({ at, time }) => (window as any).electronAPI.addAlarm({
      id: 'alarm-audio-permission-test', ...time, enabled: true, recurring: false, scheduledAt: at,
    }), { at: scheduledAt, time: alarmTime });
    expect(created.ok).toBe(true);

    await expect.poll(() => window.evaluate(() => (window as any).__beepCount), { timeout: 5000 }).toBeGreaterThanOrEqual(2);
    await expect(window.locator('#dismissAlarmBtn')).toBeVisible();
    await window.click('#dismissAlarmBtn');
    await window.evaluate(() => {
      Object.defineProperty(window, 'AudioContext', { configurable: true, value: (window as any).__originalAudioContext });
      Object.defineProperty(window, 'Notification', { configurable: true, value: (window as any).__originalNotification });
      delete (window as any).__originalAudioContext;
      delete (window as any).__originalNotification;
    });
  });

  test('adds multiple alarms', async () => {
    // Add the first alarm.
    await window.fill('#newHour', '08');
    await window.fill('#newMinute', '00');
    await window.fill('#newSecond', '00');
    await window.click('#addAlarmBtn');
    await window.waitForTimeout(300);
    
    // Add the second alarm.
    await window.fill('#newHour', '12');
    await window.fill('#newMinute', '15');
    await window.fill('#newSecond', '00');
    await window.click('#addAlarmBtn');
    await window.waitForTimeout(300);
    
    // Add the third alarm.
    await window.fill('#newHour', '18');
    await window.fill('#newMinute', '45');
    await window.fill('#newSecond', '00');
    await window.click('#addAlarmBtn');
    await window.waitForTimeout(300);
    
    // Check that all alarms are present.
    const alarmsList = window.locator('#alarmsList');
    await expect(alarmsList).toContainText('08:00:00');
    await expect(alarmsList).toContainText('12:15:00');
    await expect(alarmsList).toContainText('18:45:00');
  });

  test('edits an alarm', async () => {
    // Add an alarm.
    await window.fill('#newHour', '10');
    await window.fill('#newMinute', '00');
    await window.fill('#newSecond', '00');
    await window.click('#addAlarmBtn');
    await window.waitForTimeout(500);
    
    // Check that the alarm was added.
    const alarmsList = window.locator('#alarmsList');
    await expect(alarmsList).toContainText('10:00:00');
    
    // Find the Edit button for the 10:00:00 alarm.
    // Use a more reliable selector.
    const editBtn = window.locator('.alarm-item:has-text("10:00:00")').locator('button:has-text("Edit")');
    await editBtn.click();
    await window.waitForTimeout(500);
    
    // Check that the edit fields appear.
    // Find the fields in the alarm being edited.
    const editingItem = window.locator('.alarm-item--editing');
    const hourInput = editingItem.locator('input.alarm-item__time-input--hour');
    const minuteInput = editingItem.locator('input.alarm-item__time-input--minute');
    const secondInput = editingItem.locator('input.alarm-item__time-input--second');
    
    await expect(hourInput).toBeVisible({ timeout: 5000 });
    await expect(minuteInput).toBeVisible({ timeout: 5000 });
    await expect(secondInput).toBeVisible({ timeout: 5000 });
    
    // Change the time.
    await hourInput.fill('15');
    await minuteInput.fill('30');
    await secondInput.fill('45');
    
    // Save the changes.
    const saveBtn = editingItem.locator('button:has-text("Save")');
    await saveBtn.click();
    await window.waitForTimeout(500);
    
    // Check that the time changed.
    await expect(alarmsList).toContainText('15:30:45');
  });

  test('cancels editing an alarm', async () => {
    await window.fill('#newHour', '09');
    await window.fill('#newMinute', '00');
    await window.fill('#newSecond', '00');
    await window.click('#addAlarmBtn');
    await window.waitForTimeout(500);

    const alarmRow = window.locator('.alarm-item:has-text("09:00:00")');
    await expect(alarmRow).toBeVisible();

    await alarmRow.locator('button:has-text("Edit")').click();
    await window.waitForTimeout(300);

    const editingItem = window.locator('.alarm-item--editing');
    await editingItem.locator('input.alarm-item__time-input--hour').fill('20');
    await editingItem.locator('input.alarm-item__time-input--minute').fill('00');
    await editingItem.locator('input.alarm-item__time-input--second').fill('00');

    await editingItem.locator('button:has-text("Cancel")').click();
    await window.waitForTimeout(500);

    await expect(window.locator('.alarm-item:has-text("09:00:00")')).toBeVisible();
  });

  test('deletes an alarm', async () => {
    // Add an alarm.
    await window.fill('#newHour', '11');
    await window.fill('#newMinute', '00');
    await window.fill('#newSecond', '00');
    await window.click('#addAlarmBtn');
    await window.waitForTimeout(500);
    
    // Check that the alarm is present.
    const alarmsList = window.locator('#alarmsList');
    await expect(alarmsList).toContainText('11:00:00');
    
    // Register the confirmation dialog handler before clicking.
    const dialogPromise = new Promise<void>((resolve) => {
      window.once('dialog', async dialog => {
        await dialog.accept();
        resolve();
      });
    });
    
    // Delete the alarm.
    const deleteBtn = window.locator('.alarm-item:has-text("11:00:00")').locator('button:has-text("Delete")');
    await deleteBtn.click();
    
    // Wait for the dialog to be handled.
    await dialogPromise;
    await window.waitForTimeout(500);
    
    // Check that the alarm was deleted.
    await expect(alarmsList).not.toContainText('11:00:00');
  });

  test('enables and disables an alarm', async () => {
    // Add an alarm.
    await window.fill('#newHour', '13');
    await window.fill('#newMinute', '00');
    await window.fill('#newSecond', '00');
    await window.click('#addAlarmBtn');
    await window.waitForTimeout(500);
    
    // Find the toggle for this alarm.
    const alarmItem = window.locator('.alarm-item:has-text("13:00:00")');
    // Select the enable toggle, not the recurring toggle.
    const toggle = alarmItem.locator('input[type="checkbox"]').first();
    
    // Check that the alarm is enabled by default.
    await expect(toggle).toBeChecked();
    
    // Disable the alarm by clicking its label.
    // Select the first label, which controls whether the alarm is enabled.
    await toggle.uncheck();
    await window.waitForTimeout(1000);
    
    // Check that the toggle updated.
    // Refresh the selector because the DOM may have changed.
    const toggleAfter = alarmItem.locator('input[type="checkbox"]').first();
    await expect(toggleAfter).not.toBeChecked();
    
    // Enable the alarm again.
    await toggleAfter.check();
    await window.waitForTimeout(1000);
    const toggleAfter2 = alarmItem.locator('input[type="checkbox"]').first();
    await expect(toggleAfter2).toBeChecked();
  });

  test('validates time input', async () => {
    await window.fill('#newHour', '25');
    await window.fill('#newMinute', '00');
    await window.fill('#newSecond', '00');

    // Electron native alerts do not reliably trigger page.on('dialog'); stub it without blocking the renderer.
    await window.evaluate(() => {
      (window as unknown as { __validationAlert?: string }).__validationAlert = '';
      window.alert = (message: string) => {
        (window as unknown as { __validationAlert?: string }).__validationAlert = message;
      };
    });

    await window.click('#addAlarmBtn');

    const alertMessage = await window.evaluate(
      () => (window as unknown as { __validationAlert?: string }).__validationAlert ?? '',
    );
    expect(alertMessage).toContain('valid hour');

    const alarmsList = window.locator('#alarmsList');
    await expect(alarmsList).not.toContainText('25:00:00');
  });

  test('sorts alarms by time', async () => {
    // Add alarms in an arbitrary order.
    await window.fill('#newHour', '20');
    await window.fill('#newMinute', '00');
    await window.fill('#newSecond', '00');
    await window.click('#addAlarmBtn');
    await window.waitForTimeout(300);
    
    await window.fill('#newHour', '08');
    await window.fill('#newMinute', '00');
    await window.fill('#newSecond', '00');
    await window.click('#addAlarmBtn');
    await window.waitForTimeout(300);
    
    await window.fill('#newHour', '12');
    await window.fill('#newMinute', '00');
    await window.fill('#newSecond', '00');
    await window.click('#addAlarmBtn');
    await window.waitForTimeout(300);
    
    // Check that the alarms are sorted.
    const alarmsList = window.locator('#alarmsList');
    const text = await alarmsList.textContent();
    
    // Check the order of times in the rendered text.
    const index08 = text!.indexOf('08:00:00');
    const index12 = text!.indexOf('12:00:00');
    const index20 = text!.indexOf('20:00:00');
    
    expect(index08).toBeLessThan(index12);
    expect(index12).toBeLessThan(index20);
  });

  test('minimizes the window to the tray', async () => {
    // Ensure the window is visible.
    const isVisibleBefore = await electronApp.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0 && !windows[0].isVisible()) {
        windows[0].show();
        windows[0].focus();
      }
      return windows.length > 0 && windows[0].isVisible();
    });
    expect(isVisibleBefore).toBe(true);

    // Simulate clicking the tray icon to hide the window.
    await electronApp.evaluate(() => {
      const getTray = (global as any).__tray__;
      if (getTray) {
        const tray = getTray();
        if (tray) {
          tray.emit('click');
        }
      }
    });

    // Wait for the window to hide.
    await window.waitForTimeout(500);

    // Check that the window is hidden.
    const isVisibleAfter = await electronApp.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      return windows.length > 0 && windows[0].isVisible();
    });
    expect(isVisibleAfter).toBe(false);
  });

  test('shows the window from the tray', async () => {
    // First minimize the window to the tray.
    await window.evaluate(() => {
      (window as any).electronAPI.minimizeWindow();
    });
    await window.waitForTimeout(500);

    // Check that the window is hidden.
    const isVisibleBefore = await electronApp.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      return windows.length > 0 && windows[0].isVisible();
    });
    expect(isVisibleBefore).toBe(false);

    // Simulate clicking the tray icon.
    await electronApp.evaluate(() => {
      const getTray = (global as any).__tray__;
      if (getTray) {
        const tray = getTray();
        if (tray) {
          tray.emit('click');
        }
      }
    });

    // Wait for the window to appear.
    await window.waitForTimeout(500);

    // Check that the window is visible again.
    const isVisibleAfter = await electronApp.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      return windows.length > 0 && windows[0].isVisible();
    });
    expect(isVisibleAfter).toBe(true);

    // Ensure that the UI elements are available.
    await window.waitForSelector('#newHour', { timeout: 5000 });
  });

  test('preserves state when the window is hidden and restored', async () => {
    // Add an alarm.
    await window.fill('#newHour', '16');
    await window.fill('#newMinute', '00');
    await window.fill('#newSecond', '00');
    await window.click('#addAlarmBtn');
    await window.waitForTimeout(500);

    // Check that the alarm is present.
    const alarmsListBefore = window.locator('#alarmsList');
    await expect(alarmsListBefore).toContainText('16:00:00');

    // Minimize the window to the tray.
    await electronApp.evaluate(() => {
      const getTray = (global as any).__tray__;
      if (getTray) {
        const tray = getTray();
        if (tray) {
          tray.emit('click');
        }
      }
    });
    await window.waitForTimeout(500);

    // Show the window again.
    await electronApp.evaluate(() => {
      const getTray = (global as any).__tray__;
      if (getTray) {
        const tray = getTray();
        if (tray) {
          tray.emit('click');
        }
      }
    });
    await window.waitForTimeout(500);

    // Wait for the elements to load.
    await window.waitForSelector('#alarmsList', { timeout: 5000 });

    // Check that the alarm is still present.
    const alarmsListAfter = window.locator('#alarmsList');
    await expect(alarmsListAfter).toContainText('16:00:00');
  });
});

test.describe('Alarm Application - Initial State', () => {
  test('starts minimized to the tray', async () => {
    removeDistSettings();

    const electronPath = require('electron');
    const mainPath = path.join(__dirname, '../../dist/main.js');
    
    const testApp = await electron.launch({
      executablePath: electronPath,
      args: [mainPath],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SANDBOX: '1',
        ALARM_SETTINGS_PATH: path.join(__dirname, '../../dist/settings.json'),
      },
    });

    try {
      // Get the first application window.
      const testWindow = await testApp.firstWindow();
      
      // Wait for the application to load.
      await testWindow.waitForLoadState('domcontentloaded');
      
      // Wait briefly for initialization.
      await testWindow.waitForTimeout(1000);
      
      // Check that the window starts hidden in the tray.
      const isVisible = await testApp.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        return windows.length > 0 && windows[0].isVisible();
      });
      
      expect(isVisible).toBe(false);
    } finally {
      // Close the test application.
      await testApp.close();
    }
  });
});

