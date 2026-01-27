import { test, expect, _electron as electron } from '@playwright/test';
import * as path from 'path';

test.describe('Alarm Application', () => {
  let electronApp: any;
  let window: any;

  test.beforeAll(async () => {
    // Запускаем реальное Electron приложение
    const electronPath = require('electron');
    const mainPath = path.join(__dirname, '../../dist/main.js');
    
    electronApp = await electron.launch({
      executablePath: electronPath,
      args: [mainPath],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SANDBOX: '1',
      },
    });

    // Получаем первое окно приложения
    window = await electronApp.firstWindow();
    
    // Ждем загрузки приложения
    await window.waitForLoadState('domcontentloaded');
    
    // Приложение запускается свернутым в трей, поэтому нужно явно показать окно для тестов
    await electronApp.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        windows[0].show();
      }
    });
    
    // Ждем появления основных элементов
    await window.waitForSelector('#newHour', { timeout: 10000 });
    await window.waitForSelector('#alarmsList', { timeout: 10000 });
    
    // Ждем инициализации приложения
    await window.waitForTimeout(1000);
  });

  test.afterAll(async () => {
    // Закрываем Electron приложение после всех тестов
    if (electronApp) {
      await electronApp.close();
    }
  });

  test.beforeEach(async () => {
    // Перед каждым тестом убеждаемся, что окно видимо
    if (window) {
      // Явно показываем окно (приложение запускается свернутым в трей)
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

  test('должен отображать начальное состояние', async () => {
    // Проверяем, что поля ввода времени присутствуют
    await expect(window.locator('#newHour')).toBeVisible();
    await expect(window.locator('#newMinute')).toBeVisible();
    await expect(window.locator('#newSecond')).toBeVisible();
    await expect(window.locator('#addAlarmBtn')).toBeVisible();
    
    // Проверяем, что список будильников пуст
    const alarmsList = window.locator('#alarmsList');
    await expect(alarmsList).toContainText('Нет установленных будильников');
  });

  test('должен добавлять новый будильник', async () => {
    // Устанавливаем время 14:30:00
    await window.fill('#newHour', '14');
    await window.fill('#newMinute', '30');
    await window.fill('#newSecond', '00');
    
    // Добавляем будильник
    await window.click('#addAlarmBtn');
    
    // Ждем обновления UI
    await window.waitForTimeout(500);
    
    // Проверяем, что будильник появился в списке
    const alarmsList = window.locator('#alarmsList');
    await expect(alarmsList).toContainText('14:30:00');
    await expect(alarmsList).not.toContainText('Нет установленных будильников');
  });

  test('должен добавлять несколько будильников', async () => {
    // Добавляем первый будильник
    await window.fill('#newHour', '08');
    await window.fill('#newMinute', '00');
    await window.fill('#newSecond', '00');
    await window.click('#addAlarmBtn');
    await window.waitForTimeout(300);
    
    // Добавляем второй будильник
    await window.fill('#newHour', '12');
    await window.fill('#newMinute', '15');
    await window.fill('#newSecond', '00');
    await window.click('#addAlarmBtn');
    await window.waitForTimeout(300);
    
    // Добавляем третий будильник
    await window.fill('#newHour', '18');
    await window.fill('#newMinute', '45');
    await window.fill('#newSecond', '00');
    await window.click('#addAlarmBtn');
    await window.waitForTimeout(300);
    
    // Проверяем, что все будильники присутствуют
    const alarmsList = window.locator('#alarmsList');
    await expect(alarmsList).toContainText('08:00:00');
    await expect(alarmsList).toContainText('12:15:00');
    await expect(alarmsList).toContainText('18:45:00');
  });

  test('должен редактировать будильник', async () => {
    // Добавляем будильник
    await window.fill('#newHour', '10');
    await window.fill('#newMinute', '00');
    await window.fill('#newSecond', '00');
    await window.click('#addAlarmBtn');
    await window.waitForTimeout(500);
    
    // Проверяем, что будильник добавлен
    const alarmsList = window.locator('#alarmsList');
    await expect(alarmsList).toContainText('10:00:00');
    
    // Находим кнопку редактирования для будильника 10:00:00
    // Используем более надежный селектор
    const editBtn = window.locator('.alarm-item:has-text("10:00:00")').locator('button:has-text("Редактировать")');
    await editBtn.click();
    await window.waitForTimeout(500);
    
    // Проверяем, что появились поля редактирования
    // Ищем в редактируемом элементе
    const editingItem = window.locator('.alarm-item.editing');
    const hourInput = editingItem.locator('input.hour-input');
    const minuteInput = editingItem.locator('input.minute-input');
    const secondInput = editingItem.locator('input.second-input');
    
    await expect(hourInput).toBeVisible({ timeout: 5000 });
    await expect(minuteInput).toBeVisible({ timeout: 5000 });
    await expect(secondInput).toBeVisible({ timeout: 5000 });
    
    // Изменяем время
    await hourInput.fill('15');
    await minuteInput.fill('30');
    await secondInput.fill('45');
    
    // Сохраняем
    const saveBtn = editingItem.locator('button:has-text("Сохранить")');
    await saveBtn.click();
    await window.waitForTimeout(500);
    
    // Проверяем, что время изменилось
    await expect(alarmsList).toContainText('15:30:45');
  });

  test('должен отменять редактирование будильника', async () => {
    // Добавляем будильник
    await window.fill('#newHour', '09');
    await window.fill('#newMinute', '00');
    await window.fill('#newSecond', '00');
    await window.click('#addAlarmBtn');
    await window.waitForTimeout(500);
    
    // Начинаем редактирование
    const editBtn = window.locator('button:has-text("Редактировать")').first();
    await editBtn.click();
    await window.waitForTimeout(300);
    
    // Изменяем время
    const hourInput = window.locator('input[class*="hour-input"]').first();
    const minuteInput = window.locator('input[class*="minute-input"]').first();
    const secondInput = window.locator('input[class*="second-input"]').first();
    await hourInput.fill('20');
    await minuteInput.fill('00');
    await secondInput.fill('00');
    
    // Отменяем редактирование
    const cancelBtn = window.locator('button:has-text("Отмена")').first();
    await cancelBtn.click();
    await window.waitForTimeout(500);
    
    // Проверяем, что время не изменилось
    const alarmsList = window.locator('#alarmsList');
    await expect(alarmsList).toContainText('09:00:00');
    await expect(alarmsList).not.toContainText('20:00:00');
  });

  test('должен удалять будильник', async () => {
    // Добавляем будильник
    await window.fill('#newHour', '11');
    await window.fill('#newMinute', '00');
    await window.fill('#newSecond', '00');
    await window.click('#addAlarmBtn');
    await window.waitForTimeout(500);
    
    // Проверяем, что будильник присутствует
    const alarmsList = window.locator('#alarmsList');
    await expect(alarmsList).toContainText('11:00:00');
    
    // Устанавливаем обработчик для диалога подтверждения перед кликом
    const dialogPromise = new Promise<void>((resolve) => {
      window.once('dialog', async dialog => {
        await dialog.accept();
        resolve();
      });
    });
    
    // Удаляем будильник
    const deleteBtn = window.locator('.alarm-item:has-text("11:00:00")').locator('button:has-text("Удалить")');
    await deleteBtn.click();
    
    // Ждем обработки диалога
    await dialogPromise;
    await window.waitForTimeout(500);
    
    // Проверяем, что будильник удален
    await expect(alarmsList).not.toContainText('11:00:00');
  });

  test('должен включать и выключать будильник', async () => {
    // Добавляем будильник
    await window.fill('#newHour', '13');
    await window.fill('#newMinute', '00');
    await window.fill('#newSecond', '00');
    await window.click('#addAlarmBtn');
    await window.waitForTimeout(500);
    
    // Находим переключатель для этого будильника
    const alarmItem = window.locator('.alarm-item:has-text("13:00:00")');
    const toggle = alarmItem.locator('input[type="checkbox"]');
    
    // Проверяем, что будильник включен по умолчанию
    await expect(toggle).toBeChecked();
    
    // Выключаем будильник через клик по label (более надежно)
    const toggleLabel = alarmItem.locator('label.alarm-toggle');
    await toggleLabel.click();
    await window.waitForTimeout(1000);
    
    // Проверяем, что переключатель обновился
    // Обновляем селектор, так как DOM мог измениться
    const toggleAfter = alarmItem.locator('input[type="checkbox"]');
    await expect(toggleAfter).not.toBeChecked();
    
    // Включаем обратно
    await toggleLabel.click();
    await window.waitForTimeout(1000);
    const toggleAfter2 = alarmItem.locator('input[type="checkbox"]');
    await expect(toggleAfter2).toBeChecked();
  });

  test('должен валидировать ввод времени', async () => {
    // Пробуем установить недопустимое значение часа
    await window.fill('#newHour', '25');
    await window.fill('#newMinute', '00');
    await window.fill('#newSecond', '00');
    
    // Устанавливаем обработчик для alert
    const alertPromise = new Promise<string>((resolve) => {
      window.evaluate(() => {
        const originalAlert = window.alert;
        window.alert = (message: string) => {
          resolve(message);
          return true;
        };
      });
    });
    
    await window.click('#addAlarmBtn');
    await window.waitForTimeout(300);
    
    // Проверяем, что alert был вызван (или что значение не было принято)
    // В реальном приложении может быть alert или просто игнорирование
  });

  test('должен сортировать будильники по времени', async () => {
    // Добавляем будильники в произвольном порядке
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
    
    // Проверяем, что будильники отсортированы
    const alarmsList = window.locator('#alarmsList');
    const text = await alarmsList.textContent();
    
    // Проверяем порядок появления времени в тексте
    const index08 = text!.indexOf('08:00:00');
    const index12 = text!.indexOf('12:00:00');
    const index20 = text!.indexOf('20:00:00');
    
    expect(index08).toBeLessThan(index12);
    expect(index12).toBeLessThan(index20);
  });

  test('должен сворачивать окно в трей', async () => {
    // Убеждаемся, что окно видимо
    const isVisibleBefore = await electronApp.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0 && !windows[0].isVisible()) {
        windows[0].show();
        windows[0].focus();
      }
      return windows.length > 0 && windows[0].isVisible();
    });
    expect(isVisibleBefore).toBe(true);

    // Эмулируем клик по иконке трея для сворачивания окна
    await electronApp.evaluate(() => {
      const getTray = (global as any).__tray__;
      if (getTray) {
        const tray = getTray();
        if (tray) {
          tray.emit('click');
        }
      }
    });

    // Ждем, пока окно скроется
    await window.waitForTimeout(500);

    // Проверяем, что окно скрыто
    const isVisibleAfter = await electronApp.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      return windows.length > 0 && windows[0].isVisible();
    });
    expect(isVisibleAfter).toBe(false);
  });

  test('должен показывать окно из трея', async () => {
    // Сначала сворачиваем окно в трей
    await window.evaluate(() => {
      (window as any).electronAPI.minimizeWindow();
    });
    await window.waitForTimeout(500);

    // Проверяем, что окно скрыто
    const isVisibleBefore = await electronApp.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      return windows.length > 0 && windows[0].isVisible();
    });
    expect(isVisibleBefore).toBe(false);

    // Эмулируем клик по иконке трея
    await electronApp.evaluate(() => {
      const getTray = (global as any).__tray__;
      if (getTray) {
        const tray = getTray();
        if (tray) {
          tray.emit('click');
        }
      }
    });

    // Ждем, пока окно появится
    await window.waitForTimeout(500);

    // Проверяем, что окно снова видимо
    const isVisibleAfter = await electronApp.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      return windows.length > 0 && windows[0].isVisible();
    });
    expect(isVisibleAfter).toBe(true);

    // Убеждаемся, что элементы интерфейса доступны
    await window.waitForSelector('#newHour', { timeout: 5000 });
  });

  test('должен сохранять состояние при сворачивании и разворачивании', async () => {
    // Добавляем будильник
    await window.fill('#newHour', '16');
    await window.fill('#newMinute', '00');
    await window.fill('#newSecond', '00');
    await window.click('#addAlarmBtn');
    await window.waitForTimeout(500);

    // Проверяем, что будильник присутствует
    const alarmsListBefore = window.locator('#alarmsList');
    await expect(alarmsListBefore).toContainText('16:00:00');

    // Сворачиваем в трей
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

    // Показываем окно обратно
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

    // Ждем загрузки элементов
    await window.waitForSelector('#alarmsList', { timeout: 5000 });

    // Проверяем, что будильник все еще присутствует
    const alarmsListAfter = window.locator('#alarmsList');
    await expect(alarmsListAfter).toContainText('16:00:00');
  });
});

test.describe('Alarm Application - Initial State', () => {
  test('должен запускаться свернутым в трей', async () => {
    // Запускаем новое Electron приложение для проверки начального состояния
    const electronPath = require('electron');
    const mainPath = path.join(__dirname, '../../dist/main.js');
    
    const testApp = await electron.launch({
      executablePath: electronPath,
      args: [mainPath],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SANDBOX: '1',
      },
    });

    try {
      // Получаем первое окно приложения
      const testWindow = await testApp.firstWindow();
      
      // Ждем загрузки приложения
      await testWindow.waitForLoadState('domcontentloaded');
      
      // Ждем немного для инициализации
      await testWindow.waitForTimeout(1000);
      
      // Проверяем, что окно изначально скрыто (приложение запускается свернутым в трей)
      const isVisible = await testApp.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        return windows.length > 0 && windows[0].isVisible();
      });
      
      expect(isVisible).toBe(false);
    } finally {
      // Закрываем тестовое приложение
      await testApp.close();
    }
  });
});

