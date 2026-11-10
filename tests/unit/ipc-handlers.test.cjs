const test = require('node:test');
const assert = require('node:assert/strict');
const { registerIpcHandlers } = require('../../dist/ipc-handlers.js');

function createHarness() {
  let alarms = [];
  const channels = new Map();
  const ipc = {
    handle: (name, handler) => channels.set(name, handler),
    on: (name, handler) => channels.set(name, handler),
  };
  const noop = () => {};
  const dependencies = {
    getAlarms: () => alarms,
    setAlarms: value => { alarms = value; },
    saveSettings: noop,
    updateTrayIcon: noop,
    sendAlarmsToRenderer: noop,
    minimizeWindow: noop,
    trayClick: noop,
    toggleCountdownWindow: noop,
    destroyCountdownWindow: noop,
    showCountdownWindowMenu: noop,
    stopBlinking: noop,
    postponeAlarm: () => ({ ok: true }),
    previewAlarm: noop,
    closeAlarmPreview: noop,
    closeAlarmCreationWindow: noop,
    notifyAlarmDismissed: noop,
    openSettingsWindow: noop,
    requestQuit: noop,
    getAppPreferences: () => ({ confirmQuit: true, countdownFormat: 'compact', countdownMenuButtonVisible: true, countdownFontSize: 15 }),
    saveAppPreferences: () => ({ ok: true }),
    notifyTimezoneUpdated: noop,
    getEffectiveTimezone: () => 'UTC',
    getTimezonePref: () => null,
    setTimezonePref: noop,
  };
  registerIpcHandlers(dependencies, ipc);
  return { channels, getAlarms: () => alarms };
}

test('hourly alarms with stale dates can be created and edited', () => {
  const { channels, getAlarms } = createHarness();
  const hourly = {
    id: 'hourly-1', hour: 0, minute: 15, second: 0,
    enabled: true, recurring: true, frequency: 'hourly',
    scheduledDate: '2020-01-01',
  };

  const added = channels.get('alarm-add')({}, hourly);
  assert.deepEqual(added, { ok: true });
  assert.equal(getAlarms()[0].frequency, 'hourly');
  assert.ok(getAlarms()[0].scheduledAt > Date.now());

  const updated = channels.get('alarm-update')({}, {
    ...getAlarms()[0], scheduledDate: '2020-01-01', scheduledAt: undefined,
  });
  assert.deepEqual(updated, { ok: true });
  assert.ok(getAlarms()[0].scheduledAt > Date.now());
});

test('one-time alarms still reject a selected date in the past', () => {
  const { channels } = createHarness();
  const result = channels.get('alarm-add')({}, {
    id: 'past-once', hour: 8, minute: 0, second: 0,
    enabled: true, recurring: false, frequency: 'once',
    scheduledDate: '2020-01-01',
  });
  assert.deepEqual(result, { ok: false, error: 'Choose a future date and time.' });
});
