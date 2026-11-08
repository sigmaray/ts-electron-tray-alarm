export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface AlarmTimeInput {
  hour: number;
  minute: number;
  second: number;
  scheduledAt?: number;
}

export function localDateTimeInTimezone(timeZone: string, timestamp: number): LocalDateTime;
export function zonedDateTimeToTimestamp(timeZone: string, target: LocalDateTime): number;
export function addGregorianCalendarDays(year: number, month: number, day: number, deltaDays: number): { year: number; month: number; day: number };
export function nextAlarmTimestamp(timeZone: string, alarm: AlarmTimeInput, nowTimestamp: number): number;
export function alarmTimeHasPassedToday(timeZone: string, alarm: AlarmTimeInput, nowTimestamp: number): boolean;
