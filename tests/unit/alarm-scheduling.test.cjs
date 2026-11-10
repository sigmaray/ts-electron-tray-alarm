const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasDuplicateAlarm,
  isAlarmDateInFuture,
  requiresFutureAlarmDate,
  rescheduleAlarmsForTimezone,
  scheduleAlarm,
} = require('../../dist/alarm-scheduling.js');

function alarm(overrides = {}) {
  return {
    id: 'alarm-a', hour: 8, minute: 30, second: 0,
    enabled: true, recurring: false,
    ...overrides,
  };
}

test('permits date-bound one-shot alarms at the same time on different dates', () => {
  assert.equal(hasDuplicateAlarm(
    alarm({ scheduledDate: '2026-12-30' }),
    alarm({ id: 'alarm-b', scheduledDate: '2026-12-31' }),
  ), false);
  assert.equal(hasDuplicateAlarm(
    alarm({ scheduledDate: '2026-12-30' }),
    alarm({ id: 'alarm-b', scheduledDate: '2026-12-30' }),
  ), true);
  assert.equal(hasDuplicateAlarm(
    alarm({ scheduledDate: '2026-12-30' }),
    alarm({ id: 'alarm-b', recurring: true, scheduledDate: '2026-12-31' }),
  ), true);
});

test('validates a selected date and reschedules its wall time in a new time zone', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const dated = alarm({ scheduledDate: '2026-06-02', scheduledAt: Date.parse('2026-06-02T05:30:00.000Z') });
  assert.equal(isAlarmDateInFuture(dated, 'Europe/Minsk', now), true);
  assert.equal(isAlarmDateInFuture(alarm({ scheduledDate: '2026-05-31' }), 'Europe/Minsk', now), false);

  const [rescheduled] = rescheduleAlarmsForTimezone([dated], 'America/New_York', now);
  assert.equal(rescheduled.scheduledAt, Date.parse('2026-06-02T12:30:00.000Z'));
  assert.equal(rescheduled.scheduledDate, '2026-06-02');
});

test('only one-time alarms require their selected date to be in the future', () => {
  assert.equal(requiresFutureAlarmDate(alarm({ frequency: 'once', scheduledDate: '2026-12-31' })), true);
  assert.equal(requiresFutureAlarmDate(alarm({ frequency: 'daily', recurring: true, scheduledDate: '2026-01-01' })), false);
  assert.equal(requiresFutureAlarmDate(alarm({ frequency: 'hourly', recurring: true, scheduledDate: '2026-01-01' })), false);
});

test('keeps a quick timer as an absolute instant when the time zone changes', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const quickAt = Date.parse('2026-06-01T12:00:30.000Z');
  const [rescheduled] = rescheduleAlarmsForTimezone([
    alarm({ scheduledAt: quickAt }),
  ], 'Asia/Tokyo', now);
  assert.equal(rescheduled.scheduledAt, quickAt);
  assert.equal(rescheduled.scheduledDate, undefined);
});

test('re-enabling a completed alarm schedules its next occurrence and clears completion', () => {
  const now = Date.parse('2026-06-02T12:00:00.000Z');
  const rescheduled = scheduleAlarm(alarm({
    scheduledDate: '2026-06-01', completed: true, scheduledAt: undefined,
  }), 'UTC', now);
  assert.equal(rescheduled.scheduledDate, '2026-06-03');
  assert.equal(rescheduled.scheduledAt, Date.parse('2026-06-03T08:30:00.000Z'));
  assert.equal(rescheduled.completed, undefined);
});

test('scheduling handles disabled and hourly alarms without retaining stale state', () => {
  const now = Date.parse('2026-06-01T12:15:00.000Z');
  const disabled = scheduleAlarm(alarm({
    enabled: false, scheduledAt: now - 1000, completed: true,
  }), 'UTC', now);
  assert.equal(disabled.scheduledAt, undefined);
  assert.equal(disabled.completed, true);

  const hourly = scheduleAlarm(alarm({
    frequency: 'hourly', recurring: true, hour: 0, minute: 30, second: 0,
    scheduledAt: now - 1000, completed: true,
  }), 'UTC', now);
  assert.equal(hourly.scheduledAt, Date.parse('2026-06-01T12:30:00.000Z'));
  assert.equal(hourly.scheduledDate, '2026-06-01');
  assert.equal(hourly.completed, undefined);
});

test('rescheduling moves recurring and elapsed alarms while preserving disabled alarms', () => {
  const now = Date.parse('2026-06-02T12:00:00.000Z');
  const [hourly, daily, elapsedOnce, disabled] = rescheduleAlarmsForTimezone([
    alarm({ frequency: 'hourly', recurring: true, minute: 30 }),
    alarm({ frequency: 'daily', recurring: true, scheduledDate: '2026-06-01' }),
    alarm({ scheduledDate: undefined, hour: 8, minute: 0 }),
    alarm({ enabled: false, scheduledAt: now + 30_000 }),
  ], 'UTC', now);

  assert.equal(hourly.scheduledAt, Date.parse('2026-06-02T12:30:00.000Z'));
  assert.equal(daily.scheduledDate, '2026-06-03');
  assert.equal(elapsedOnce.scheduledDate, '2026-06-03');
  assert.equal(disabled.scheduledAt, now + 30_000);
});
