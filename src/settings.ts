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
}

export interface AppSettings {
  alarms: Alarm[];
  countdownWindowVisible: boolean;
  timezone?: string | null;
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

function parseAlarm(raw: unknown): Alarm | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `alarm-${randomUUID()}`;
  return {
    id,
    hour: clampTimeUnit(item.hour, 0, 23),
    minute: clampTimeUnit(item.minute, 0, 59),
    second: clampTimeUnit(item.second, 0, 59),
    enabled: Boolean(item.enabled),
    recurring: Boolean(item.recurring),
  };
}

export function parseAlarms(raw: unknown): Alarm[] {
  return Array.isArray(raw) ? raw.map(parseAlarm).filter((alarm): alarm is Alarm => alarm !== null) : [];
}

export function parseSettings(raw: unknown): AppSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultSettings();
  const value = raw as Record<string, unknown>;
  return {
    alarms: parseAlarms(value.alarms),
    countdownWindowVisible: Boolean(value.countdownWindowVisible),
    timezone: value.timezone == null ? undefined : String(value.timezone),
  };
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
