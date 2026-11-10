import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface Alarm {
  id: string;
  hour: number;
  minute: number;
  second: number;
  enabled: boolean;
  recurring: boolean;
  frequency?: 'once' | 'daily' | 'hourly';
  notificationMode?: 'system' | 'window' | 'both';
  postponeMinutes?: number;
  sound?: 'classic' | 'digital' | 'gentle';
  scheduledAt?: number;
  scheduledDate?: string;
  dateExplicit?: boolean;
  message?: string;
  completed?: boolean;
}

export interface AppSettings {
  alarms: Alarm[];
  countdownWindowVisible: boolean;
  countdownWindowPosition?: CountdownWindowPosition;
  timezone?: string | null;
}

export interface CountdownWindowPosition {
  displayId: string;
  displayLabel?: string;
  displayBounds?: { x: number; y: number; width: number; height: number };
  x: number;
  y: number;
}

export interface SettingsPaths {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  userDataPath: string;
  overridePath?: string;
}

export const DEFAULT_SETTINGS: AppSettings = { alarms: [], countdownWindowVisible: false };

function defaultSettings(): AppSettings {
  return { alarms: [], countdownWindowVisible: false };
}

function clampTimeUnit(value: unknown, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

const ALARM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function parseAlarm(raw: unknown): Alarm | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const candidateId = typeof item.id === 'string' ? item.id.trim() : '';
  const id = ALARM_ID_PATTERN.test(candidateId) ? candidateId : `alarm-${randomUUID()}`;
  const scheduledAt = typeof item.scheduledAt === 'number' && Number.isFinite(item.scheduledAt) && Math.abs(item.scheduledAt) <= 8.64e15
    ? item.scheduledAt
    : undefined;
  return {
    id,
    hour: clampTimeUnit(item.hour, 0, 23),
    minute: clampTimeUnit(item.minute, 0, 59),
    second: clampTimeUnit(item.second, 0, 59),
    enabled: item.enabled === true,
    recurring: item.recurring === true,
    ...(item.frequency === 'once' || item.frequency === 'daily' || item.frequency === 'hourly' ? { frequency: item.frequency } : {}),
    ...(item.notificationMode === 'system' || item.notificationMode === 'window' || item.notificationMode === 'both' ? { notificationMode: item.notificationMode } : {}),
    ...(Number.isInteger(item.postponeMinutes) && Number(item.postponeMinutes) >= 1 && Number(item.postponeMinutes) <= 60 ? { postponeMinutes: Number(item.postponeMinutes) } : {}),
    ...(item.sound === 'classic' || item.sound === 'digital' || item.sound === 'gentle' ? { sound: item.sound } : {}),
    ...(scheduledAt === undefined ? {} : { scheduledAt }),
    ...(isValidDate(item.scheduledDate) ? { scheduledDate: item.scheduledDate as string } : {}),
    ...(typeof item.dateExplicit === 'boolean'
      ? { dateExplicit: item.dateExplicit }
      : (isValidDate(item.scheduledDate) ? { dateExplicit: true } : {})),
    ...(typeof item.message === 'string' ? { message: item.message.slice(0, 500) } : {}),
    ...(item.completed === true ? { completed: true } : {}),
  };
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseAlarms(raw: unknown): Alarm[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  return raw.map(parseAlarm).filter((alarm): alarm is Alarm => {
    if (!alarm) return false;
    if (ids.has(alarm.id)) alarm.id = `alarm-${randomUUID()}`;
    ids.add(alarm.id);
    return true;
  });
}

export function normalizeTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const timeZone = value.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return null;
  }
}

export function isValidAlarmPayload(value: unknown): value is Alarm {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const alarm = value as Record<string, unknown>;
  return typeof alarm.id === 'string'
    && ALARM_ID_PATTERN.test(alarm.id)
    && Number.isInteger(alarm.hour) && (alarm.hour as number) >= 0 && (alarm.hour as number) <= 23
    && Number.isInteger(alarm.minute) && (alarm.minute as number) >= 0 && (alarm.minute as number) <= 59
    && Number.isInteger(alarm.second) && (alarm.second as number) >= 0 && (alarm.second as number) <= 59
    && typeof alarm.enabled === 'boolean'
    && typeof alarm.recurring === 'boolean'
    && (alarm.frequency === undefined || alarm.frequency === 'once' || alarm.frequency === 'daily' || alarm.frequency === 'hourly')
    && (alarm.notificationMode === undefined || alarm.notificationMode === 'system' || alarm.notificationMode === 'window' || alarm.notificationMode === 'both')
    && (alarm.postponeMinutes === undefined || (Number.isInteger(alarm.postponeMinutes) && (alarm.postponeMinutes as number) >= 1 && (alarm.postponeMinutes as number) <= 60))
    && (alarm.sound === undefined || alarm.sound === 'classic' || alarm.sound === 'digital' || alarm.sound === 'gentle')
    && (alarm.scheduledAt === undefined || (typeof alarm.scheduledAt === 'number' && Number.isFinite(alarm.scheduledAt) && Math.abs(alarm.scheduledAt) <= 8.64e15))
    && (alarm.scheduledDate === undefined || isValidDate(alarm.scheduledDate))
    && (alarm.dateExplicit === undefined || typeof alarm.dateExplicit === 'boolean')
    && (alarm.message === undefined || (typeof alarm.message === 'string' && alarm.message.length <= 500))
    && (alarm.completed === undefined || typeof alarm.completed === 'boolean');
}

export function parseSettings(raw: unknown): AppSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultSettings();
  const value = raw as Record<string, unknown>;
  const rawPosition = value.countdownWindowPosition;
  const countdownWindowPosition = rawPosition && typeof rawPosition === 'object' && !Array.isArray(rawPosition)
    ? rawPosition as Record<string, unknown>
    : undefined;
  const validCountdownPosition = countdownWindowPosition
    && ((typeof countdownWindowPosition.displayId === 'number' && Number.isFinite(countdownWindowPosition.displayId))
      || (typeof countdownWindowPosition.displayId === 'string' && countdownWindowPosition.displayId.length <= 64))
    && Number.isSafeInteger(countdownWindowPosition.x)
    && Number.isSafeInteger(countdownWindowPosition.y)
    ? {
      displayId: String(countdownWindowPosition.displayId),
      ...(typeof countdownWindowPosition.displayLabel === 'string' && countdownWindowPosition.displayLabel.length <= 256
        ? { displayLabel: countdownWindowPosition.displayLabel }
        : {}),
      ...(isDisplayBounds(countdownWindowPosition.displayBounds)
        ? { displayBounds: countdownWindowPosition.displayBounds }
        : {}),
      x: countdownWindowPosition.x as number,
      y: countdownWindowPosition.y as number,
    }
    : undefined;
  return {
    alarms: parseAlarms(value.alarms),
    countdownWindowVisible: value.countdownWindowVisible === true,
    ...(validCountdownPosition ? { countdownWindowPosition: validCountdownPosition } : {}),
    timezone: normalizeTimeZone(value.timezone) ?? undefined,
  };
}

function isDisplayBounds(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const bounds = value as Record<string, unknown>;
  return Number.isSafeInteger(bounds.x) && Number.isSafeInteger(bounds.y)
    && Number.isSafeInteger(bounds.width) && Number.isSafeInteger(bounds.height)
    && (bounds.width as number) > 0 && (bounds.height as number) > 0;
}

/** Resolve storage, migrate the former app-directory file, and fall back from read-only portable installs. */
export function createSettingsStore(paths: SettingsPaths) {
  let fallbackPath: string | null = null;
  const userDataFile = path.join(paths.userDataPath, 'settings.json');
  const getPath = (): string => {
    if (paths.overridePath) return paths.overridePath;
    if (fallbackPath) return fallbackPath;
    const marker = path.join(paths.resourcesPath, 'portable-mode');
    if (paths.isPackaged && fs.existsSync(marker)) {
      try {
        fs.accessSync(paths.resourcesPath, fs.constants.W_OK);
        const portable = path.join(paths.resourcesPath, 'settings.json');
        if (!fs.existsSync(portable) && fs.existsSync(userDataFile)) fs.copyFileSync(userDataFile, portable);
        return portable;
      } catch {
        return userDataFile;
      }
    }
    return userDataFile;
  };
  const migrateLegacy = (destination: string): void => {
    if (paths.overridePath) return;
    const legacyPaths = [path.join(paths.appPath, 'settings.json'), path.join(paths.appPath, 'dist', 'settings.json')];
    if (!fs.existsSync(destination)) {
      for (const legacy of legacyPaths) {
        if (destination === legacy || !fs.existsSync(legacy)) continue;
        try {
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.copyFileSync(legacy, destination);
          console.info(`[settings] Migrated settings from ${legacy} to ${destination}`);
          return;
        } catch (error) {
          console.warn(`[settings] Could not migrate legacy settings from ${legacy}`, error);
        }
      }
    }
  };
  return {
    getPath,
    load(): AppSettings {
      let target = getPath();
      migrateLegacy(target);
      console.info(`[settings] Loading ${target} (exists: ${fs.existsSync(target)})`);
      try {
        if (!fs.existsSync(target)) {
          const defaults = defaultSettings();
          console.info(`[settings] No settings file found; creating defaults at ${target}`);
          this.save(defaults);
          return defaults;
        }
        const parsed = parseSettings(JSON.parse(fs.readFileSync(target, 'utf8')));
        console.info(`[settings] Loaded ${target}`);
        return parsed;
      } catch (error) {
        console.error(`[settings] Could not load ${target}`, error);
        return defaultSettings();
      }
    },
    save(settings: AppSettings): void {
      let target = getPath();
      migrateLegacy(target);
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(settings, null, 2), 'utf8');
        console.info(`[settings] Saved ${target}`);
      } catch (error) {
        const portable = paths.isPackaged && !paths.overridePath && target !== userDataFile;
        if (portable) {
          console.warn(`[settings] Could not save portable settings at ${target}; using ${userDataFile}`, error);
          fallbackPath = userDataFile;
          target = userDataFile;
          try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, JSON.stringify(settings, null, 2), 'utf8');
            console.info(`[settings] Saved ${target}`);
            return;
          } catch (fallbackError) {
            console.error(`[settings] Could not save ${target}`, fallbackError);
            return;
          }
        }
        console.error(`[settings] Could not save ${target}`, error);
      }
    },
  };
}
