import { Alarm } from './settings';
import { alarmTimeHasPassedToday, localDateTimeInTimezone, nextAlarmTimestamp, zonedDateTimeToTimestamp } from './time.js';

function dateFromTimestamp(timeZone: string, timestamp: number): string {
  const local = localDateTimeInTimezone(timeZone, timestamp);
  return `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
}

function timestampForAlarmDate(alarm: Alarm, timeZone: string): number | undefined {
  if (!alarm.scheduledDate) return undefined;
  const [year, month, day] = alarm.scheduledDate.split('-').map(Number);
  return zonedDateTimeToTimestamp(timeZone, {
    year, month, day, hour: alarm.hour, minute: alarm.minute, second: alarm.second,
  });
}

export function hasDuplicateAlarm(existing: Alarm, candidate: Alarm): boolean {
  if (existing.hour !== candidate.hour || existing.minute !== candidate.minute || existing.second !== candidate.second) return false;

  const bothDateBoundOneShots = !existing.recurring && !candidate.recurring
    && existing.scheduledDate !== undefined && candidate.scheduledDate !== undefined;
  if (bothDateBoundOneShots) return existing.scheduledDate === candidate.scheduledDate;
  return true;
}

export function isAlarmDateInFuture(alarm: Alarm, timeZone: string, now: number = Date.now()): boolean {
  const target = timestampForAlarmDate(alarm, timeZone);
  return target === undefined || target > now;
}

export function scheduleAlarm(alarm: Alarm, timeZone: string, now: number = Date.now()): Alarm {
  const scheduled = { ...alarm };
  if (!scheduled.enabled) {
    delete scheduled.scheduledAt;
    return scheduled;
  }

  if (scheduled.scheduledDate) {
    const target = timestampForAlarmDate(scheduled, timeZone)!;
    if (target > now) {
      scheduled.scheduledAt = target;
      delete scheduled.completed;
      return scheduled;
    }
    if (scheduled.completed) {
      scheduled.scheduledAt = nextAlarmTimestamp(timeZone, { ...scheduled, scheduledAt: undefined }, now);
      scheduled.scheduledDate = dateFromTimestamp(timeZone, scheduled.scheduledAt);
      delete scheduled.completed;
      return scheduled;
    }
  }

  if (scheduled.completed) {
    scheduled.scheduledAt = nextAlarmTimestamp(timeZone, { ...scheduled, scheduledAt: undefined }, now);
    scheduled.scheduledDate = dateFromTimestamp(timeZone, scheduled.scheduledAt);
    delete scheduled.completed;
    return scheduled;
  }

  if (scheduled.scheduledAt === undefined && alarmTimeHasPassedToday(timeZone, scheduled, now)) {
    scheduled.scheduledAt = nextAlarmTimestamp(timeZone, scheduled, now);
    scheduled.scheduledDate = dateFromTimestamp(timeZone, scheduled.scheduledAt);
  }
  return scheduled;
}

export function rescheduleAlarmsForTimezone(alarms: Alarm[], timeZone: string, now: number = Date.now()): Alarm[] {
  return alarms.map(alarm => {
    if (!alarm.enabled) return alarm;

    if (alarm.scheduledDate) {
      const target = timestampForAlarmDate(alarm, timeZone)!;
      if (alarm.recurring && target <= now) {
        const next = nextAlarmTimestamp(timeZone, { ...alarm, scheduledAt: undefined }, now);
        return { ...alarm, scheduledAt: next, scheduledDate: dateFromTimestamp(timeZone, next) };
      }
      return { ...alarm, scheduledAt: target };
    }

    // Quick timers without a selected date represent an absolute instant.
    if (alarm.scheduledAt !== undefined) return alarm;

    if (alarm.recurring) {
      const next = nextAlarmTimestamp(timeZone, alarm, now);
      return { ...alarm, scheduledAt: next, scheduledDate: dateFromTimestamp(timeZone, next) };
    }

    if (alarmTimeHasPassedToday(timeZone, alarm, now)) {
      const next = nextAlarmTimestamp(timeZone, alarm, now);
      return { ...alarm, scheduledAt: next, scheduledDate: dateFromTimestamp(timeZone, next) };
    }
    return alarm;
  });
}
