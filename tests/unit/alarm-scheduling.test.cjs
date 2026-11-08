const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasDuplicateAlarm,
  isAlarmDateInFuture,
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
