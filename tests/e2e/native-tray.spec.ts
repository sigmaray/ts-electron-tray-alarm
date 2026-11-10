import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

test('native tray menu opens and exposes its expected entries', async () => {
  const mode = process.env.E2E_NATIVE_TRAY;
  const coordinates = {
    trayX: process.env.TRAY_ICON_X,
    trayY: process.env.TRAY_ICON_Y,
    newAlarmX: process.env.TRAY_MENU_NEW_ALARM_X,
    newAlarmY: process.env.TRAY_MENU_NEW_ALARM_Y,
    mainX: process.env.TRAY_MENU_MAIN_X,
    mainY: process.env.TRAY_MENU_MAIN_Y,
    countdownX: process.env.TRAY_MENU_COUNTDOWN_X,
    countdownY: process.env.TRAY_MENU_COUNTDOWN_Y,
  };
  test.skip(process.platform !== 'linux' || (mode !== 'ci' && mode !== '1')
    || (mode === '1' && Object.values(coordinates).some(value => !value || !Number.isFinite(Number(value)))),
  'Enable E2E_NATIVE_TRAY=ci in CI, or E2E_NATIVE_TRAY=1 with screen coordinates for a desktop tray.');

  const helperSource = path.join(__dirname, 'helpers/native-x11-input.c');
  const helperBinary = path.join(os.tmpdir(), `native-x11-input-${process.pid}`);
  const settingsPath = path.join(os.tmpdir(), `alarm-native-tray-${process.pid}.json`);
  try { fs.unlinkSync(settingsPath); } catch { /* No previous test settings exist. */ }
  execFileSync('gcc', [helperSource, '-o', helperBinary, '-lXtst', '-lX11']);

  const app = await electron.launch({
    executablePath: require('electron'),
    args: [path.join(__dirname, '../../dist/main.js')],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: '1',
      ALLOW_ONLY_ONE_INSTANCE: 'false',
      ALARM_SETTINGS_PATH: settingsPath,
    },
  });

  try {
    await expect.poll(() => app.windows().some(page => page.url().includes('index.html'))).toBe(true);
    const openMenu = async () => {
      if (mode === 'ci') {
        // Xvfb has no system tray host; open the app's actual native menu at a fixed point.
        await app.evaluate(({ BrowserWindow }) => {
          const main = BrowserWindow.getAllWindows().find((item: any) => item.webContents.getURL().includes('index.html'));
          main?.show();
          (global as any).__trayMenu__().popup({ window: main, x: 120, y: 120 });
        });
      } else {
        execFileSync(helperBinary, ['click', coordinates.trayX!, coordinates.trayY!, '3']);
      }
      await expect.poll(() => app.evaluate(() => (global as any).__trayState__().menuOpen)).toBe(true);
    };
    const clickMenuItem = async (index: number) => {
      const itemCoordinates = [
        [coordinates.newAlarmX, coordinates.newAlarmY],
        [coordinates.mainX, coordinates.mainY],
        [coordinates.countdownX, coordinates.countdownY],
      ][index];
      execFileSync(helperBinary, ['click', itemCoordinates[0]!, itemCoordinates[1]!, '1']);
      await expect.poll(() => app.evaluate(() => (global as any).__trayState__().menuOpen)).toBe(false);
    };
    const mainIsVisible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((item: any) => item.webContents.getURL().includes('index.html'))?.isVisible());

    if (mode === 'ci') {
      await openMenu();
      const entries = await app.evaluate(() => (global as any).__trayMenu__().items.map((item: any) => item.label));
      expect(entries).toContain('New alarm');
      expect(entries).toContain('Hide main window');
      expect(entries).toContain('Show countdown window');
      await app.evaluate(() => (global as any).__trayMenu__().closePopup());
      await expect.poll(() => app.evaluate(() => (global as any).__trayState__().menuOpen)).toBe(false);
      return;
    }
    await openMenu();
    expect(await app.evaluate(() => (global as any).__trayMenu__().getMenuItemById('tray-main-window').label))
      .toBe('Show main window');
    await clickMenuItem(1);
    await expect.poll(mainIsVisible).toBe(true);

    await openMenu();
    expect(await app.evaluate(() => (global as any).__trayMenu__().getMenuItemById('tray-main-window').label))
      .toBe('Hide main window');
    await clickMenuItem(1);
    await expect.poll(mainIsVisible).toBe(false);

    await openMenu();
    const newAlarmWindow = app.waitForEvent('window');
    await clickMenuItem(0);
    const alarmCreation = await newAlarmWindow;
    await expect(alarmCreation).toHaveURL(/alarmDialogOnly=1/);
    await alarmCreation.close();
  } finally {
    await app.close();
    try { fs.unlinkSync(helperBinary); } catch { /* Temporary helper is already gone. */ }
    try { fs.unlinkSync(settingsPath); } catch { /* Temporary settings are already gone. */ }
  }
});
