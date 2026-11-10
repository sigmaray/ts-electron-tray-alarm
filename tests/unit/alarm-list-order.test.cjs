const test = require('node:test');
const assert = require('node:assert/strict');
const { sortAlarmsForFrequency } = require('../../dist/alarm-list-order.js');

function alarm(id, overrides = {}) {
  return {
    id, hour: 8, minute: 0, second: 0,
    enabled: true, recurring: false,
    ...overrides,
  };
}

test('once and daily alarms sort enabled first, disabled next, completed last, then by nearest time', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const items = [
    alarm('completed', { enabled: false, completed: true, scheduledDate: '2026-05-31' }),
    alarm('disabled', { enabled: false, scheduledAt: now + 10_000 }),
    alarm('enabled-far', { scheduledAt: now + 300_000 }),
    alarm('enabled-near', { scheduledAt: now - 5_000 }),
  ];

  const once = sortAlarmsForFrequency(items, 'once', 'UTC', now);
  assert.deepEqual(once.map(item => item.id), ['enabled-near', 'enabled-far', 'disabled', 'completed']);
  const daily = sortAlarmsForFrequency(items, 'daily', 'UTC', now);
  assert.deepEqual(daily.map(item => item.id), ['enabled-near', 'enabled-far', 'disabled', 'completed']);
});

test('hourly alarms sort enabled first, then numerically by minute and second', () => {
  const items = [
    alarm('disabled-early', { frequency: 'hourly', enabled: false, minute: 0 }),
    alarm('enabled-late', { frequency: 'hourly', minute: 59 }),
    alarm('enabled-early', { frequency: 'hourly', minute: 5, second: 2 }),
    alarm('enabled-same-minute', { frequency: 'hourly', minute: 5, second: 0 }),
  ];

  const sorted = sortAlarmsForFrequency(items, 'hourly', 'UTC', Date.now());
  assert.deepEqual(sorted.map(item => item.id), [
    'enabled-same-minute', 'enabled-early', 'enabled-late', 'disabled-early',
  ]);
});

test('once alarms use their selected calendar date when no cached timestamp exists', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const sorted = sortAlarmsForFrequency([
    alarm('later-date', { scheduledDate: '2026-06-20', hour: 9 }),
    alarm('nearer-date', { scheduledDate: '2026-06-03', hour: 9 }),
  ], 'once', 'UTC', now);

  assert.deepEqual(sorted.map(item => item.id), ['nearer-date', 'later-date']);
});
