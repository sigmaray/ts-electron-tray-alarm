const test = require('node:test');
const assert = require('node:assert/strict');
const { alarmTimeHasPassedToday, nextAlarmTimestamp, zonedDateTimeToTimestamp } = require('../../dist/time.js');

test('resolves wall times on both sides of a spring-forward transition', () => {
  const beforeGap = zonedDateTimeToTimestamp('America/New_York', {
    year: 2024, month: 3, day: 10, hour: 1, minute: 30, second: 0,
  });
  const insideGap = zonedDateTimeToTimestamp('America/New_York', {
    year: 2024, month: 3, day: 10, hour: 2, minute: 30, second: 0,
  });
  const afterGap = zonedDateTimeToTimestamp('America/New_York', {
    year: 2024, month: 3, day: 10, hour: 3, minute: 30, second: 0,
  });
  assert.equal(new Date(beforeGap).toISOString(), '2024-03-10T06:30:00.000Z');
  assert.equal(new Date(insideGap).toISOString(), '2024-03-10T07:30:00.000Z');
  assert.equal(insideGap, afterGap);
});

test('chooses the first occurrence of an ambiguous fall-back wall time', () => {
  const timestamp = zonedDateTimeToTimestamp('America/New_York', {
    year: 2024, month: 11, day: 3, hour: 1, minute: 30, second: 0,
  });
  assert.equal(new Date(timestamp).toISOString(), '2024-11-03T05:30:00.000Z');
});

test('keeps a quick alarm scheduled at its absolute timestamp across midnight', () => {
  const now = Date.parse('2026-11-08T23:59:45.000Z');
  const scheduledAt = Date.parse('2026-11-09T00:00:15.000Z');
  const timestamp = nextAlarmTimestamp('UTC', {
    hour: 0, minute: 0, second: 15, scheduledAt,
  }, now);
  assert.equal(timestamp, scheduledAt);
  assert.equal(timestamp - now, 30_000);
});

test('moves a regular daily alarm to tomorrow when today’s time has passed', () => {
  const now = Date.parse('2026-11-08T23:59:45.000Z');
  const timestamp = nextAlarmTimestamp('UTC', { hour: 0, minute: 0, second: 15 }, now);
  assert.equal(new Date(timestamp).toISOString(), '2026-11-09T00:00:15.000Z');
});

test('detects when enabling a daily alarm should defer it until tomorrow', () => {
  const now = Date.parse('2026-11-08T23:59:45.000Z');
  assert.equal(alarmTimeHasPassedToday('UTC', { hour: 0, minute: 0, second: 15 }, now), true);
  assert.equal(alarmTimeHasPassedToday('UTC', { hour: 23, minute: 59, second: 50 }, now), false);
});
