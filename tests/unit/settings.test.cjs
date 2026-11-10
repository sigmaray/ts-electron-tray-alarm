const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidAlarmPayload, normalizeTimeZone, parseAlarms, parseSettings, createSettingsStore } = require('../../dist/settings.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('parseAlarms validates shape and clamps time fields', () => {
  assert.deepEqual(parseAlarms([
    { id: '  wake  ', hour: 26.8, minute: -1, second: '42', enabled: 1, recurring: false },
    null,
    'invalid',
  ]), [{ id: 'wake', hour: 23, minute: 0, second: 42, enabled: false, recurring: false }]);
});

test('parseSettings returns defaults for invalid input and preserves preferences', () => {
  assert.deepEqual(parseSettings(null), { alarms: [], countdownWindowVisible: true });
  assert.deepEqual(parseSettings({ alarms: [], countdownWindowVisible: true, timezone: 'Europe/Minsk' }), {
    alarms: [], countdownWindowVisible: true, timezone: 'Europe/Minsk',
  });
});

test('parseSettings discards an invalid time zone', () => {
  assert.deepEqual(parseSettings({ timezone: 'Not/A_Real_Zone' }).timezone, undefined);
  assert.equal(normalizeTimeZone(' Europe/Minsk '), 'Europe/Minsk');
});

test('parseSettings validates countdown preferences, position, and font size', () => {
  const parsed = parseSettings({
    confirmQuit: false,
    countdownFormat: 'seconds',
    countdownMenuButtonVisible: false,
    countdownFontSize: 32,
    countdownWindowPosition: {
      displayId: 123, displayLabel: 'External display', x: -1920, y: 20,
      displayBounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    },
  });
  assert.equal(parsed.confirmQuit, false);
  assert.equal(parsed.countdownFormat, 'seconds');
  assert.equal(parsed.countdownMenuButtonVisible, false);
  assert.equal(parsed.countdownFontSize, 32);
  assert.deepEqual(parsed.countdownWindowPosition, {
    displayId: '123', displayLabel: 'External display', x: -1920, y: 20,
    displayBounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  });
  assert.equal(parseSettings({ countdownFontSize: 33 }).countdownFontSize, undefined);
  assert.equal(parseSettings({ countdownFontSize: 'medium' }).countdownFontSize, 15);
});

test('parseSettings keeps valid color overrides and discards malformed hex values', () => {
  const parsed = parseSettings({
    trayIconColor: '#12AbEf',
    countdownBackgroundColor: '#abcdef',
    mainWindowBackgroundColor: '#F8F9FA',
    sectionHeaderBackgroundColor: '#0D6EFd',
    sectionBackgroundColor: '#ffffff',
  });
  assert.equal(parsed.trayIconColor, '#12abef');
  assert.equal(parsed.countdownBackgroundColor, '#abcdef');
  assert.equal(parsed.mainWindowBackgroundColor, '#f8f9fa');
  assert.equal(parsed.sectionHeaderBackgroundColor, '#0d6efd');
  assert.equal(parsed.sectionBackgroundColor, '#ffffff');

  const malformed = parseSettings({
    trayIconColor: '#123',
    countdownBackgroundColor: 'red',
    mainWindowBackgroundColor: '#12345g',
    sectionHeaderBackgroundColor: '#12345',
    sectionBackgroundColor: 'transparent',
  });
  assert.equal(malformed.trayIconColor, undefined);
  assert.equal(malformed.countdownBackgroundColor, undefined);
  assert.equal(malformed.mainWindowBackgroundColor, undefined);
  assert.equal(malformed.sectionHeaderBackgroundColor, undefined);
  assert.equal(malformed.sectionBackgroundColor, undefined);
});

test('parseAlarms replaces unsafe and duplicate IDs', () => {
  const alarms = parseAlarms([
    { id: 'safe-id', hour: 1, minute: 2, second: 3 },
    { id: 'safe-id', hour: 4, minute: 5, second: 6 },
    { id: `"><img src=x onerror=alert(1)>`, hour: 7, minute: 8, second: 9 },
  ]);
  assert.equal(alarms[0].id, 'safe-id');
  assert.notEqual(alarms[1].id, 'safe-id');
  assert.match(alarms[2].id, /^alarm-/);
});

test('IPC alarm validation accepts only safe IDs and valid fields', () => {
  const valid = { id: 'alarm-123', hour: 23, minute: 59, second: 59, enabled: true, recurring: false };
  assert.equal(isValidAlarmPayload(valid), true);
  assert.equal(isValidAlarmPayload({ ...valid, id: "x');alert(1);//" }), false);
  assert.equal(isValidAlarmPayload({ ...valid, minute: 60 }), false);
  assert.equal(isValidAlarmPayload({ ...valid, scheduledDate: '2026-12-31', message: 'Wake up' }), true);
  assert.equal(isValidAlarmPayload({ ...valid, scheduledDate: '2026-02-30' }), false);
  assert.equal(isValidAlarmPayload({ ...valid, message: 'x'.repeat(501) }), false);
  assert.equal(isValidAlarmPayload({ ...valid, completed: true }), true);
  assert.equal(isValidAlarmPayload({ ...valid, completed: 'yes' }), false);
});

test('alarm options survive settings parsing with bounded notification text', () => {
  const alarm = parseAlarms([{
    id: 'dated-alarm', hour: 8, minute: 0, second: 0, enabled: true, recurring: false,
    scheduledDate: '2026-12-31', message: 'Take medication',
  }])[0];
  assert.equal(alarm.scheduledDate, '2026-12-31');
  assert.equal(alarm.message, 'Take medication');
  const sanitized = parseAlarms([{
    id: 'dated-alarm', hour: 8, minute: 0, second: 0, enabled: true, recurring: false,
    scheduledDate: '2026-02-30', message: 'x'.repeat(501),
  }])[0];
  assert.equal(sanitized.scheduledDate, undefined);
  assert.equal(sanitized.message.length, 500);
});

test('settings parsing preserves the completed state for one-shot alarms', () => {
  const [alarm] = parseAlarms([{
    id: 'completed-alarm', hour: 8, minute: 0, second: 0, enabled: false,
    recurring: false, scheduledDate: '2026-12-31', completed: true,
  }]);
  assert.equal(alarm.completed, true);
});

test('settings migrate from the former app directory into userData', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-alarm-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, 'legacy-app');
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(appPath, { recursive: true });
  fs.writeFileSync(path.join(appPath, 'settings.json'), JSON.stringify({
    alarms: [{ id: 'legacy-alarm', hour: 7, minute: 30, second: 0, enabled: true, recurring: false }],
  }));
  const store = createSettingsStore({
    isPackaged: false,
    appPath,
    resourcesPath: path.join(root, 'resources'),
    userDataPath,
  });
  assert.equal(store.load().alarms[0].id, 'legacy-alarm');
  assert.equal(fs.existsSync(path.join(userDataPath, 'settings.json')), true);
});

test('portable mode creates and uses settings.json beside the portable marker', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-alarm-portable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, 'app');
  const resourcesPath = path.join(root, 'resources');
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(appPath, { recursive: true });
  fs.mkdirSync(resourcesPath, { recursive: true });
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(path.join(resourcesPath, 'portable-mode'), '');

  const store = createSettingsStore({ isPackaged: false, appPath, resourcesPath, userDataPath });
  const portableSettingsPath = path.join(resourcesPath, 'settings.json');
  assert.equal(store.getPath(), portableSettingsPath);
  assert.equal(fs.existsSync(portableSettingsPath), false);

  assert.deepEqual(store.load(), { alarms: [], countdownWindowVisible: true });
  assert.equal(fs.existsSync(portableSettingsPath), true);
  assert.equal(fs.existsSync(path.join(userDataPath, 'settings.json')), false);
  store.save({ alarms: [], countdownWindowVisible: true, confirmQuit: false });
  assert.equal(JSON.parse(fs.readFileSync(portableSettingsPath, 'utf8')).confirmQuit, false);
});

test('portable mode also recognizes a marker in the app directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-alarm-portable-app-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, 'app');
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(appPath, { recursive: true });
  fs.writeFileSync(path.join(appPath, 'portable-mode'), '');

  const store = createSettingsStore({
    isPackaged: false, appPath, resourcesPath: path.join(root, 'resources'), userDataPath,
  });
  assert.equal(store.getPath(), path.join(appPath, 'settings.json'));
  store.load();
  assert.equal(fs.existsSync(path.join(appPath, 'settings.json')), true);
});
