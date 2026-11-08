const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAlarms, parseSettings } = require('../../dist/settings.js');

test('parseAlarms validates shape and clamps time fields', () => {
  assert.deepEqual(parseAlarms([
    { id: '  wake  ', hour: 26.8, minute: -1, second: '42', enabled: 1, recurring: false },
    null,
    'invalid',
  ]), [{ id: 'wake', hour: 23, minute: 0, second: 42, enabled: true, recurring: false }]);
});

test('parseSettings returns defaults for invalid input and preserves preferences', () => {
  assert.deepEqual(parseSettings(null), { alarms: [], countdownWindowVisible: false });
  assert.deepEqual(parseSettings({ alarms: [], countdownWindowVisible: true, timezone: 'Europe/Minsk' }), {
    alarms: [], countdownWindowVisible: true, timezone: 'Europe/Minsk',
  });
});
