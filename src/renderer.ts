// Типы для electronAPI
interface Alarm {
  id: string;
  hour: number;
  minute: number;
  second: number;
  enabled: boolean;
  recurring: boolean;
}

interface ElectronAPI {
  minimizeWindow: () => void;
  closeApp: () => void;
  addAlarm: (alarm: Alarm) => void;
  updateAlarm: (alarm: Alarm) => void;
  deleteAlarm: (alarmId: string) => void;
  getAllAlarms: () => void;
  dismissAlarm: () => void;
  onAlarmsUpdated: (callback: (alarms: Alarm[]) => void) => void;
  onAlarmTriggered: (callback: (alarmId: string) => void) => void;
  onAlarmDismissFromMain: (callback: () => void) => void;
  removeAlarmsUpdatedListener: () => void;
  removeAlarmTriggeredListener: () => void;
  toggleCountdownWindow: () => void;
  onCountdownWindowState: (callback: (visible: boolean) => void) => void;
  onCountdownUpdate: (callback: (text: string) => void) => void;
  getTimezones: () => Promise<string[]>;
  getCurrentTimezone: () => Promise<{ effective: string; isSystem: boolean }>;
  setTimezone: (tz: string | null) => Promise<{ effective: string; isSystem: boolean }>;
}

let alarms: Alarm[] = [];
let editingAlarmId: string | null = null;
let audioContext: AudioContext | null = null;
let audioInterval: NodeJS.Timeout | null = null;
let isAlarmPlaying: boolean = false;
let alarmNotification: Notification | null = null;
let notificationCheckInterval: NodeJS.Timeout | null = null;
let timeUpdateInterval: NodeJS.Timeout | null = null;
let currentTimezoneInfo: { effective: string; isSystem: boolean } | null = null;
let timeTimezoneInterval: ReturnType<typeof setInterval> | null = null;

function updateTimeTimezoneDisplay(): void {
  const el = document.getElementById('currentTimeTimezone');
  if (!el || !currentTimezoneInfo) return;
  const formatter = new Intl.DateTimeFormat('ru', {
    timeZone: currentTimezoneInfo.effective,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const timeStr = formatter.format(new Date());
  const tzLabel = currentTimezoneInfo.isSystem
    ? `Системная таймзона: ${currentTimezoneInfo.effective}`
    : ` ${currentTimezoneInfo.effective}`;
  el.textContent = `${timeStr} (${tzLabel})`;
}

function generateAlarmId(): string {
  return `alarm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function formatTime(hour: number, minute: number, second: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

// Текущие локальные дата и время в указанной таймзоне (для расчёта «через …»)
function getLocalTimeInTimezone(tz: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string) => {
    const p = parts.find(x => x.type === type);
    return p ? parseInt(p.value, 10) : 0;
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

// UTC-метка момента (year, month, day, hour, minute, second) в таймзоне tz
function getTimestampInTimezone(tz: string, year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const dayNoonUTC = Date.UTC(year, month - 1, day, 12, 0, 0);
  const parts = formatter.formatToParts(dayNoonUTC);
  const get = (type: string) => {
    const p = parts.find(x => x.type === type);
    return p ? parseInt(p.value, 10) : 0;
  };
  const localHour = get('hour');
  const localMinute = get('minute');
  const localSecond = get('second');
  const offsetSec = (localHour * 3600 + localMinute * 60 + localSecond) - 12 * 3600;
  const offsetMs = offsetSec * 1000;
  return Date.UTC(year, month - 1, day, hour, minute, second) - offsetMs;
}

/** Сдвиг календарной даты в григорианском календаре. `Date.UTC` — только нормализация (переходы месяца/года), не системная таймзона. */
function addGregorianCalendarDays(year: number, month: number, day: number, deltaDays: number): { year: number; month: number; day: number } {
  const ms = Date.UTC(year, month - 1, day + deltaDays);
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// Локальные час, минута, секунда в таймзоне tz для заданной UTC-метки (для кнопок «через …»)
function getLocalTimeFromTimestamp(tz: string, timestamp: number): { hour: number; minute: number; second: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(timestamp));
  const get = (type: string) => {
    const p = parts.find(x => x.type === type);
    return p ? parseInt(p.value, 10) : 0;
  };
  return { hour: get('hour'), minute: get('minute'), second: get('second') };
}

function getTimeUntilAlarm(alarm: Alarm): number {
  const tz = currentTimezoneInfo?.effective ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const local = getLocalTimeInTimezone(tz);
  let alarmTs = getTimestampInTimezone(tz, local.year, local.month, local.day, alarm.hour, alarm.minute, alarm.second);
  if (alarmTs <= now.getTime()) {
    const next = addGregorianCalendarDays(local.year, local.month, local.day, 1);
    alarmTs = getTimestampInTimezone(tz, next.year, next.month, next.day, alarm.hour, alarm.minute, alarm.second);
  }
  return Math.floor((alarmTs - now.getTime()) / 1000);
}

function formatTimeUntil(seconds: number): string {
  if (seconds <= 0) return 'Сейчас';
  if (seconds < 60) return `через ${seconds}с`;
  
  const mins = Math.floor(seconds / 60);
  if (mins < 60) {
    return `через ${mins}м`;
  }
  
  const hours = Math.floor(seconds / 3600);
  const remainingMins = Math.floor((seconds % 3600) / 60);
  
  if (remainingMins === 0) {
    return `через ${hours}ч`;
  }
  return `через ${hours}ч ${remainingMins}м`;
}

function hasAlarmAtTime(hour: number, minute: number, second: number, excludeAlarmId?: string): boolean {
  return alarms.some(alarm => {
    // Пропускаем будильник, который редактируется
    if (excludeAlarmId && alarm.id === excludeAlarmId) {
      return false;
    }
    return alarm.hour === hour && alarm.minute === minute && alarm.second === second;
  });
}

function updateTimeUntilForAlarms(): void {
  // Обновляем только время до срабатывания для будильников, не находящихся в режиме редактирования
  alarms.forEach(alarm => {
    if (alarm.id === editingAlarmId) return; // Пропускаем редактируемый будильник
    
    const alarmItem = document.querySelector(`.alarm-item[data-id="${alarm.id}"]`);
    if (!alarmItem) return;
    
    const timeUntilElement = alarmItem.querySelector('.alarm-time-until');
    if (alarm.enabled) {
      const timeUntil = getTimeUntilAlarm(alarm);
      const timeUntilStr = formatTimeUntil(timeUntil);
      
      if (timeUntilElement) {
        timeUntilElement.textContent = timeUntilStr;
      } else {
        // Если элемента нет, но будильник включен, добавляем его
        const timeGroup = alarmItem.querySelector('.alarm-time-group');
        if (timeGroup) {
          const timeUntilSpan = document.createElement('span');
          timeUntilSpan.className = 'alarm-time-until';
          timeUntilSpan.textContent = timeUntilStr;
          timeGroup.appendChild(timeUntilSpan);
        }
      }
    } else {
      // Если будильник выключен, удаляем элемент времени до срабатывания
      if (timeUntilElement) {
        timeUntilElement.remove();
      }
    }
  });
}

function setupTimeInputHandlers(input: HTMLInputElement): void {
  // Проверяем, не добавлены ли уже обработчики (используя data-атрибут)
  if ((input as any).__timeHandlersSetup) {
    return; // Обработчики уже добавлены
  }
  
  // При фокусе очищаем поле, если значение "0" или "00"
  input.addEventListener('focus', function focusHandler() {
    if (this.value === '0' || this.value === '00') {
      this.value = '';
    }
  });
  
  // При потере фокуса, если поле пустое, устанавливаем "0"
  input.addEventListener('blur', function blurHandler() {
    if (this.value === '' || this.value.trim() === '') {
      this.value = '0';
    }
  });
  
  // Помечаем, что обработчики добавлены
  (input as any).__timeHandlersSetup = true;
}

function renderAlarms(): void {
  const container = document.getElementById('alarmsList');
  if (!container) return;

  // Сохраняем значения полей редактирования и информацию о фокусе перед перерисовкой
  let editingValues: { hour: string; minute: string; second: string; focusedField: string | null } | null = null;
  if (editingAlarmId) {
    const hourInput = document.getElementById(`edit-hour-${editingAlarmId}`) as HTMLInputElement;
    const minuteInput = document.getElementById(`edit-minute-${editingAlarmId}`) as HTMLInputElement;
    const secondInput = document.getElementById(`edit-second-${editingAlarmId}`) as HTMLInputElement;
    
    if (hourInput && minuteInput && secondInput) {
      // Определяем, какое поле имеет фокус
      let focusedField: string | null = null;
      if (document.activeElement === hourInput) {
        focusedField = 'hour';
      } else if (document.activeElement === minuteInput) {
        focusedField = 'minute';
      } else if (document.activeElement === secondInput) {
        focusedField = 'second';
      }
      
      // Сохраняем позицию курсора
      const activeElement = document.activeElement as HTMLInputElement;
      const cursorPosition = activeElement && (activeElement === hourInput || activeElement === minuteInput || activeElement === secondInput) 
        ? activeElement.selectionStart 
        : null;
      
      editingValues = {
        hour: hourInput.value,
        minute: minuteInput.value,
        second: secondInput.value,
        focusedField: focusedField,
        cursorPosition: cursorPosition
      } as any;
    }
  }

  if (alarms.length === 0) {
    container.innerHTML = '<div class="no-alarms">Нет установленных будильников</div>';
    return;
  }

  // Сортируем будильники по времени
  const sortedAlarms = [...alarms].sort((a, b) => {
    if (a.hour !== b.hour) return a.hour - b.hour;
    if (a.minute !== b.minute) return a.minute - b.minute;
    return a.second - b.second;
  });

  container.innerHTML = sortedAlarms.map(alarm => {
    const isEditing = editingAlarmId === alarm.id;
    const timeStr = formatTime(alarm.hour, alarm.minute, alarm.second);
    
    if (isEditing) {
      // Используем сохраненные значения, если они есть, иначе значения из будильника
      const hourValue = editingValues ? editingValues.hour : alarm.hour;
      const minuteValue = editingValues ? editingValues.minute : alarm.minute;
      const secondValue = editingValues ? editingValues.second : alarm.second;
      
      return `
        <div class="alarm-item editing" data-id="${alarm.id}">
          <div class="alarm-time-input">
            <input type="number" min="0" max="23" value="${hourValue}" class="hour-input" id="edit-hour-${alarm.id}">
            <span>:</span>
            <input type="number" min="0" max="59" value="${minuteValue}" class="minute-input" id="edit-minute-${alarm.id}">
            <span>:</span>
            <input type="number" min="0" max="59" value="${secondValue}" class="second-input" id="edit-second-${alarm.id}">
          </div>
          <div class="quick-time-links">
            <a href="#" class="quick-time-link" onclick="setQuickTimeSecondsForEdit('${alarm.id}', 30); return false;">через 30 секунд</a>
            <a href="#" class="quick-time-link" onclick="setQuickTimeSecondsForEdit('${alarm.id}', 60); return false;">через 1 минуту</a>
            <a href="#" class="quick-time-link" onclick="setQuickTimeForEdit('${alarm.id}', 2); return false;">через 2 минуты</a>
            <a href="#" class="quick-time-link" onclick="setQuickTimeForEdit('${alarm.id}', 5); return false;">через 5 минут</a>
            <a href="#" class="quick-time-link" onclick="setQuickTimeForEdit('${alarm.id}', 30); return false;">через 30 минут</a>
            <a href="#" class="quick-time-link" onclick="setQuickTimeForEdit('${alarm.id}', 60); return false;">через 1 час</a>
            <a href="#" class="quick-time-link" onclick="setQuickTimeForEdit('${alarm.id}', 120); return false;">через 2 часа</a>
          </div>
          <div class="alarm-actions">
            <button class="btn-save" onclick="saveAlarm('${alarm.id}')">Сохранить</button>
            <button class="btn-cancel" onclick="cancelEdit('${alarm.id}')">Отмена</button>
          </div>
        </div>
      `;
    } else {
      const timeUntil = alarm.enabled ? getTimeUntilAlarm(alarm) : 0;
      const timeUntilStr = alarm.enabled ? formatTimeUntil(timeUntil) : '';
      
      return `
        <div class="alarm-item" data-id="${alarm.id}">
          <div class="alarm-info">
            <div class="alarm-time-group">
              <span class="alarm-time">${timeStr}</span>
              ${alarm.enabled && timeUntilStr ? `<span class="alarm-time-until">${timeUntilStr}</span>` : ''}
            </div>
            <div class="alarm-toggles">
              <div class="toggle-group">
                <label class="alarm-toggle with-label" title="Включить/выключить будильник">
                  <input type="checkbox" ${alarm.enabled ? 'checked' : ''} onchange="toggleAlarm('${alarm.id}', this.checked)">
                  <span class="toggle-slider"></span>
                </label>
                <span class="toggle-label">Вкл</span>
              </div>
              <div class="toggle-group">
                <label class="alarm-toggle recurring-toggle with-label" title="Повторяющийся будильник">
                  <input type="checkbox" ${alarm.recurring ? 'checked' : ''} onchange="toggleRecurring('${alarm.id}', this.checked)">
                  <span class="toggle-slider"></span>
                </label>
                <span class="toggle-label">Повтор</span>
              </div>
            </div>
          </div>
          <div class="alarm-actions">
            <button class="btn-edit" onclick="editAlarm('${alarm.id}')">Редактировать</button>
            <button class="btn-delete" onclick="deleteAlarm('${alarm.id}')">Удалить</button>
          </div>
        </div>
      `;
    }
  }).join('');

  // Восстанавливаем фокус и позицию курсора после перерисовки
  if (editingAlarmId && editingValues && editingValues.focusedField) {
    setTimeout(() => {
      let inputToFocus: HTMLInputElement | null = null;
      if (editingValues!.focusedField === 'hour') {
        inputToFocus = document.getElementById(`edit-hour-${editingAlarmId}`) as HTMLInputElement;
      } else if (editingValues!.focusedField === 'minute') {
        inputToFocus = document.getElementById(`edit-minute-${editingAlarmId}`) as HTMLInputElement;
      } else if (editingValues!.focusedField === 'second') {
        inputToFocus = document.getElementById(`edit-second-${editingAlarmId}`) as HTMLInputElement;
      }
      
      if (inputToFocus) {
        // Настраиваем обработчики для полей редактирования
        setupTimeInputHandlers(inputToFocus);
        inputToFocus.focus();
        // Восстанавливаем позицию курсора
        const cursorPos = (editingValues as any).cursorPosition;
        if (cursorPos !== null && cursorPos !== undefined) {
          inputToFocus.setSelectionRange(cursorPos, cursorPos);
        }
      }
      
      // Настраиваем обработчики для всех полей редактирования
      const hourInput = document.getElementById(`edit-hour-${editingAlarmId}`) as HTMLInputElement;
      const minuteInput = document.getElementById(`edit-minute-${editingAlarmId}`) as HTMLInputElement;
      const secondInput = document.getElementById(`edit-second-${editingAlarmId}`) as HTMLInputElement;
      
      if (hourInput) setupTimeInputHandlers(hourInput);
      if (minuteInput) setupTimeInputHandlers(minuteInput);
      if (secondInput) setupTimeInputHandlers(secondInput);
    }, 0);
  }
}

function getEffectiveTimezoneForQuick(): string {
  return currentTimezoneInfo?.effective ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function setQuickTime(minutes: number): void {
  const hourInput = document.getElementById('newHour') as HTMLInputElement;
  const minuteInput = document.getElementById('newMinute') as HTMLInputElement;
  const secondInput = document.getElementById('newSecond') as HTMLInputElement;
  
  if (!hourInput || !minuteInput || !secondInput) return;

  const tz = getEffectiveTimezoneForQuick();
  const futureTs = Date.now() + minutes * 60 * 1000;
  const { hour, minute, second } = getLocalTimeFromTimestamp(tz, futureTs);

  hourInput.value = String(hour).padStart(2, '0');
  minuteInput.value = String(minute).padStart(2, '0');
  secondInput.value = String(second).padStart(2, '0');
}

function setQuickTimeSeconds(seconds: number): void {
  const hourInput = document.getElementById('newHour') as HTMLInputElement;
  const minuteInput = document.getElementById('newMinute') as HTMLInputElement;
  const secondInput = document.getElementById('newSecond') as HTMLInputElement;
  
  if (!hourInput || !minuteInput || !secondInput) return;

  const tz = getEffectiveTimezoneForQuick();
  const futureTs = Date.now() + seconds * 1000;
  const { hour, minute, second } = getLocalTimeFromTimestamp(tz, futureTs);

  hourInput.value = String(hour).padStart(2, '0');
  minuteInput.value = String(minute).padStart(2, '0');
  secondInput.value = String(second).padStart(2, '0');
}

function setQuickTimeForEdit(alarmId: string, minutes: number): void {
  const hourInput = document.getElementById(`edit-hour-${alarmId}`) as HTMLInputElement;
  const minuteInput = document.getElementById(`edit-minute-${alarmId}`) as HTMLInputElement;
  const secondInput = document.getElementById(`edit-second-${alarmId}`) as HTMLInputElement;
  
  if (!hourInput || !minuteInput || !secondInput) return;

  const tz = getEffectiveTimezoneForQuick();
  const futureTs = Date.now() + minutes * 60 * 1000;
  const { hour, minute, second } = getLocalTimeFromTimestamp(tz, futureTs);

  hourInput.value = String(hour).padStart(2, '0');
  minuteInput.value = String(minute).padStart(2, '0');
  secondInput.value = String(second).padStart(2, '0');
}

function setQuickTimeSecondsForEdit(alarmId: string, seconds: number): void {
  const hourInput = document.getElementById(`edit-hour-${alarmId}`) as HTMLInputElement;
  const minuteInput = document.getElementById(`edit-minute-${alarmId}`) as HTMLInputElement;
  const secondInput = document.getElementById(`edit-second-${alarmId}`) as HTMLInputElement;
  
  if (!hourInput || !minuteInput || !secondInput) return;

  const tz = getEffectiveTimezoneForQuick();
  const futureTs = Date.now() + seconds * 1000;
  const { hour, minute, second } = getLocalTimeFromTimestamp(tz, futureTs);

  hourInput.value = String(hour).padStart(2, '0');
  minuteInput.value = String(minute).padStart(2, '0');
  secondInput.value = String(second).padStart(2, '0');
}

function addAlarm(): void {
  const hourInput = document.getElementById('newHour') as HTMLInputElement;
  const minuteInput = document.getElementById('newMinute') as HTMLInputElement;
  const secondInput = document.getElementById('newSecond') as HTMLInputElement;
  
  if (!hourInput || !minuteInput || !secondInput) return;

  const hour = parseInt(hourInput.value, 10);
  const minute = parseInt(minuteInput.value, 10);
  const second = parseInt(secondInput.value, 10);

  if (isNaN(hour) || hour < 0 || hour > 23) {
    alert('Введите корректный час (0-23)');
    return;
  }

  if (isNaN(minute) || minute < 0 || minute > 59) {
    alert('Введите корректные минуты (0-59)');
    return;
  }

  if (isNaN(second) || second < 0 || second > 59) {
    alert('Введите корректные секунды (0-59)');
    return;
  }

  // Проверяем, нет ли уже будильника с таким же временем
  if (hasAlarmAtTime(hour, minute, second)) {
    alert('Будильник на это время уже существует!');
    return;
  }

  const recurringInput = document.getElementById('newRecurring') as HTMLInputElement;
  const recurring = recurringInput ? recurringInput.checked : false;

  const newAlarm: Alarm = {
    id: generateAlarmId(),
    hour,
    minute,
    second,
    enabled: true,
    recurring,
  };

  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  if (electronAPI) {
    electronAPI.addAlarm(newAlarm);
  }

  // Сбрасываем поля ввода
  hourInput.value = '00';
  minuteInput.value = '00';
  secondInput.value = '00';
  if (recurringInput) {
    recurringInput.checked = false;
  }
}

function editAlarm(alarmId: string): void {
  editingAlarmId = alarmId;
  renderAlarms();
  
  // Настраиваем обработчики для полей редактирования после перерисовки
  setTimeout(() => {
    const hourInput = document.getElementById(`edit-hour-${alarmId}`) as HTMLInputElement;
    const minuteInput = document.getElementById(`edit-minute-${alarmId}`) as HTMLInputElement;
    const secondInput = document.getElementById(`edit-second-${alarmId}`) as HTMLInputElement;
    
    if (hourInput) setupTimeInputHandlers(hourInput);
    if (minuteInput) setupTimeInputHandlers(minuteInput);
    if (secondInput) setupTimeInputHandlers(secondInput);
  }, 0);
}

function cancelEdit(alarmId: string): void {
  editingAlarmId = null;
  renderAlarms();
}

function saveAlarm(alarmId: string): void {
  const hourInput = document.getElementById(`edit-hour-${alarmId}`) as HTMLInputElement;
  const minuteInput = document.getElementById(`edit-minute-${alarmId}`) as HTMLInputElement;
  const secondInput = document.getElementById(`edit-second-${alarmId}`) as HTMLInputElement;

  if (!hourInput || !minuteInput || !secondInput) return;

  // Если поле пустое, используем 0
  const hour = hourInput.value === '' ? 0 : parseInt(hourInput.value, 10);
  const minute = minuteInput.value === '' ? 0 : parseInt(minuteInput.value, 10);
  const second = secondInput.value === '' ? 0 : parseInt(secondInput.value, 10);

  if (isNaN(hour) || hour < 0 || hour > 23) {
    alert('Введите корректный час (0-23)');
    return;
  }

  if (isNaN(minute) || minute < 0 || minute > 59) {
    alert('Введите корректные минуты (0-59)');
    return;
  }

  if (isNaN(second) || second < 0 || second > 59) {
    alert('Введите корректные секунды (0-59)');
    return;
  }

  const alarm = alarms.find(a => a.id === alarmId);
  if (!alarm) return;

  // Проверяем, нет ли уже другого будильника с таким же временем
  if (hasAlarmAtTime(hour, minute, second, alarmId)) {
    alert('Будильник на это время уже существует!');
    return;
  }

  // При редактировании сохраняем текущее значение recurring (не меняем его)
  const updatedAlarm: Alarm = {
    ...alarm,
    hour,
    minute,
    second,
    // recurring остается без изменений
  };

  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  if (electronAPI) {
    electronAPI.updateAlarm(updatedAlarm);
  }

  editingAlarmId = null;
}

function deleteAlarm(alarmId: string): void {
  if (!confirm('Вы уверены, что хотите удалить этот будильник?')) {
    return;
  }

  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  if (electronAPI) {
    electronAPI.deleteAlarm(alarmId);
  }
}

function toggleAlarm(alarmId: string, enabled: boolean): void {
  const alarm = alarms.find(a => a.id === alarmId);
  if (!alarm) return;

  const updatedAlarm: Alarm = {
    ...alarm,
    enabled,
  };

  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  if (electronAPI) {
    electronAPI.updateAlarm(updatedAlarm);
  }
}

function toggleRecurring(alarmId: string, recurring: boolean): void {
  const alarm = alarms.find(a => a.id === alarmId);
  if (!alarm) return;

  const updatedAlarm: Alarm = {
    ...alarm,
    recurring,
  };

  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  if (electronAPI) {
    electronAPI.updateAlarm(updatedAlarm);
  }
}

function playAlarmSound(): void {
  // Создаем звуковой сигнал с помощью Web Audio API
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    audioContext = new AudioContextClass();

    function playBeep(): void {
      if (!audioContext) return;

      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.value = 800; // Частота в Гц
      oscillator.type = 'sine';

      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.5);
    }

    // Играем звук каждые 0.6 секунды
    isAlarmPlaying = true;
    playBeep();
    audioInterval = setInterval(() => {
      // Проверяем, что звук должен играть и уведомление существует
      if (audioContext && isAlarmPlaying) {
        // Проверяем, что уведомление все еще активно (не закрыто)
        if (alarmNotification) {
          playBeep();
        } else {
          // Уведомление было закрыто, останавливаем звук
          stopAlarmSound();
        }
      } else {
        stopAlarmSound();
      }
    }, 600);
  } catch (e) {
    console.error('Ошибка воспроизведения звука:', e);
  }
}

function stopAlarmSound(): void {
  isAlarmPlaying = false;
  if (audioInterval) {
    clearInterval(audioInterval);
    audioInterval = null;
  }
  if (notificationCheckInterval) {
    clearInterval(notificationCheckInterval);
    notificationCheckInterval = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {
      // Игнорируем ошибки при закрытии
    });
    audioContext = null;
  }
  if (alarmNotification) {
    alarmNotification.close();
    alarmNotification = null;
  }
  updateDismissButton();
}

function updateDismissButton(): void {
  const dismissBtn = document.getElementById('dismissAlarmBtn') as HTMLButtonElement;
  if (dismissBtn) {
    dismissBtn.style.display = (isAlarmPlaying || alarmNotification !== null) ? 'block' : 'none';
  }
}

function dismissAlarm(): void {
  stopAlarmSound();
  
  // Останавливаем мигание иконки в трее
  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  if (electronAPI) {
    electronAPI.dismissAlarm();
  }
}

function showAlarmNotification(alarm: Alarm): void {
  // Запрашиваем разрешение на уведомления
  if (Notification.permission === 'default') {
    Notification.requestPermission();
  }

  if (Notification.permission === 'granted') {
    const timeStr = formatTime(alarm.hour, alarm.minute, alarm.second);
    alarmNotification = new Notification('⏰ Будильник!', {
      body: `Время: ${timeStr}`,
      requireInteraction: true,
      tag: 'alarm-alert'
    });

    // Функция для обработки закрытия уведомления
    const handleNotificationClose = () => {
      console.log('Браузерное уведомление закрыто, останавливаем звук');
      // Убеждаемся, что звук останавливается
      if (isAlarmPlaying) {
        dismissAlarm();
      }
    };

    // Функция для обработки клика по уведомлению
    const handleNotificationClick = () => {
      console.log('Клик по браузерному уведомлению, останавливаем звук');
      if (isAlarmPlaying) {
        dismissAlarm();
      }
      if (window.focus) window.focus();
    };

    // Останавливаем звук и мигание когда уведомление закрыто
    // Используем и addEventListener, и свойства для максимальной совместимости
    try {
      alarmNotification.addEventListener('close', handleNotificationClose);
    } catch (e) {
      console.warn('Не удалось добавить addEventListener для close:', e);
    }
    
    // Также используем свойство onclose (может работать в некоторых версиях Electron)
    alarmNotification.onclose = handleNotificationClose;

    // Останавливаем звук и мигание при клике на уведомление
    try {
      alarmNotification.addEventListener('click', handleNotificationClick);
    } catch (e) {
      console.warn('Не удалось добавить addEventListener для click:', e);
    }
    
    alarmNotification.onclick = handleNotificationClick;
    
    // Дополнительная защита: используем событие error, если уведомление не может быть показано
    try {
      alarmNotification.addEventListener('error', (e) => {
        console.error('Ошибка браузерного уведомления:', e);
      });
    } catch (e) {
      // Игнорируем ошибки при добавлении обработчика error
    }
  } else {
    // Если уведомления не разрешены, показываем alert
    const timeStr = formatTime(alarm.hour, alarm.minute, alarm.second);
    alert(`⏰ Будильник! Время: ${timeStr}`);
    // Останавливаем звук и мигание после закрытия alert
    dismissAlarm();
  }
}

// Экспортируем функции для глобального доступа
(window as any).addAlarm = addAlarm;
(window as any).editAlarm = editAlarm;
(window as any).cancelEdit = cancelEdit;
(window as any).saveAlarm = saveAlarm;
(window as any).deleteAlarm = deleteAlarm;
(window as any).toggleAlarm = toggleAlarm;
(window as any).toggleRecurring = toggleRecurring;
(window as any).setQuickTime = setQuickTime;
(window as any).setQuickTimeSeconds = setQuickTimeSeconds;
(window as any).setQuickTimeForEdit = setQuickTimeForEdit;
(window as any).setQuickTimeSecondsForEdit = setQuickTimeSecondsForEdit;

// Инициализация при загрузке страницы
document.addEventListener('DOMContentLoaded', () => {
  // Запрашиваем разрешение на уведомления при загрузке
  if (Notification.permission === 'default') {
    Notification.requestPermission();
  }

  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  if (electronAPI) {
    // Состояние окна отсчёта времени
    electronAPI.onCountdownWindowState((visible: boolean) => {
      const btn = document.getElementById('countdownWindowBtn') as HTMLButtonElement;
      if (btn) {
        btn.textContent = visible ? 'Скрыть окно отсчёта времени' : 'Показывать окно отсчёта времени';
      }
    });

    // Время и таймзона в основном окне
    electronAPI.getCurrentTimezone().then((info) => {
      currentTimezoneInfo = info;
      updateTimeTimezoneDisplay();
      if (timeTimezoneInterval) clearInterval(timeTimezoneInterval);
      timeTimezoneInterval = setInterval(updateTimeTimezoneDisplay, 60000);
    });

    // Запрашиваем список будильников
    electronAPI.getAllAlarms();

    // Слушаем обновления будильников
    electronAPI.onAlarmsUpdated((updatedAlarms) => {
      alarms = updatedAlarms;
      renderAlarms();
    });

    // Запускаем обновление времени до срабатывания будильников каждую секунду
    if (timeUpdateInterval) {
      clearInterval(timeUpdateInterval);
    }
    timeUpdateInterval = setInterval(() => {
      // Если есть будильник в режиме редактирования, обновляем только время до срабатывания
      // без полной перерисовки, чтобы не сбрасывать фокус
      if (editingAlarmId) {
        updateTimeUntilForAlarms();
      } else {
        renderAlarms();
      }
    }, 1000);

    // Слушаем срабатывание будильника
    electronAPI.onAlarmTriggered((alarmId) => {
      const alarm = alarms.find(a => a.id === alarmId);
      if (alarm) {
        // Воспроизводим звук
        playAlarmSound();
        updateDismissButton();
        // Показываем уведомление
        showAlarmNotification(alarm);
      }
    });

    // Слушаем сообщение от main процесса о закрытии нативного уведомления
    electronAPI.onAlarmDismissFromMain(() => {
      console.log('Получено сообщение от main процесса о закрытии нативного уведомления');
      // Останавливаем звук
      isAlarmPlaying = false;
      if (audioInterval) {
        clearInterval(audioInterval);
        audioInterval = null;
      }
      if (audioContext) {
        audioContext.close().catch(() => {});
        audioContext = null;
      }
      // Закрываем браузерное уведомление, если оно активно
      if (alarmNotification) {
        try {
          alarmNotification.close();
        } catch (e) {
          console.error('Ошибка при закрытии браузерного уведомления:', e);
        }
        alarmNotification = null;
      }
      // Обновляем кнопку
      updateDismissButton();
      // Отправляем подтверждение обратно в main процесс (хотя это уже сделано через dismissAlarm)
      // Но мы уже вызвали stopBlinking в main, так что просто обновляем состояние
    });
  }

  // Обработка Enter в полях ввода
  const hourInput = document.getElementById('newHour') as HTMLInputElement;
  const minuteInput = document.getElementById('newMinute') as HTMLInputElement;
  const secondInput = document.getElementById('newSecond') as HTMLInputElement;
  const addBtn = document.getElementById('addAlarmBtn');

  if (hourInput) {
    setupTimeInputHandlers(hourInput);
    hourInput.addEventListener('keypress', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        minuteInput?.focus();
      }
    });
  }

  if (minuteInput) {
    setupTimeInputHandlers(minuteInput);
    minuteInput.addEventListener('keypress', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        secondInput?.focus();
      }
    });
  }

  if (secondInput) {
    setupTimeInputHandlers(secondInput);
    secondInput.addEventListener('keypress', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && addBtn) {
        addAlarm();
      }
    });
  }

  if (addBtn) {
    addBtn.addEventListener('click', addAlarm);
  }

  // Обработчики кнопок управления приложением
  const countdownWindowBtn = document.getElementById('countdownWindowBtn');
  const minimizeBtn = document.getElementById('minimizeBtn');
  const closeBtn = document.getElementById('closeBtn');

  if (countdownWindowBtn) {
    countdownWindowBtn.addEventListener('click', () => {
      const api = (window as any).electronAPI as ElectronAPI | undefined;
      if (api) api.toggleCountdownWindow();
    });
  }

  if (minimizeBtn) {
    minimizeBtn.addEventListener('click', () => {
      const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
      if (electronAPI) {
        electronAPI.minimizeWindow();
      }
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      const confirmed = confirm('Вы уверены, что хотите закрыть приложение?');
      if (confirmed) {
        const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
        if (electronAPI) {
          electronAPI.closeApp();
        }
      }
    });
  }

  // Обработчик кнопки отключения звука будильника
  const dismissBtn = document.getElementById('dismissAlarmBtn');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', dismissAlarm);
  }

  // Окно выбора таймзоны
  const timezoneBtn = document.getElementById('timezoneBtn');
  const timezoneModalOverlay = document.getElementById('timezoneModalOverlay');
  const timezoneList = document.getElementById('timezoneList');
  const timezoneSearch = document.getElementById('timezoneSearch') as HTMLInputElement;
  const timezoneCurrentLabel = document.getElementById('timezoneCurrentLabel');
  const timezoneSaveBtn = document.getElementById('timezoneSaveBtn');
  const timezoneCancelBtn = document.getElementById('timezoneCancelBtn');

  let allTimezones: string[] = [];
  let selectedTimezoneValue: string | null = null;

  function renderTimezoneList(filter: string): void {
    if (!timezoneList) return;
    const q = (filter || '').toLowerCase().trim();
    const filtered = q
      ? allTimezones.filter(tz => tz.toLowerCase().includes(q))
      : allTimezones;
    const systemLabel = 'Системная таймзона (по умолчанию)';
    const selected = selectedTimezoneValue;
    const systemSelected = selected === null ? ' selected' : '';
    let html = `<div class="tz-option system${systemSelected}" data-tz="">${systemLabel}</div>`;
    filtered.forEach(tz => {
      const cls = tz === selected ? 'tz-option selected' : 'tz-option';
      html += `<div class="${cls}" data-tz="${escapeHtml(tz)}">${escapeHtml(tz)}</div>`;
    });
    timezoneList.innerHTML = html;
    timezoneList.querySelectorAll('.tz-option').forEach(el => {
      el.addEventListener('click', () => {
        selectedTimezoneValue = (el as HTMLElement).getAttribute('data-tz') || null;
        if (selectedTimezoneValue === '') selectedTimezoneValue = null;
        renderTimezoneList(timezoneSearch ? timezoneSearch.value : '');
      });
    });
  }

  function escapeHtml(s: string): string {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  if (timezoneBtn && timezoneModalOverlay && electronAPI) {
    timezoneBtn.addEventListener('click', async () => {
      const { effective, isSystem } = await electronAPI.getCurrentTimezone();
      timezoneCurrentLabel!.textContent = isSystem
        ? `Текущая: Системная таймзона (${effective})`
        : 'Текущая: ' + effective;
      selectedTimezoneValue = isSystem ? null : effective;
      if (allTimezones.length === 0) {
        allTimezones = await electronAPI.getTimezones();
        allTimezones.sort();
      }
      renderTimezoneList(timezoneSearch ? timezoneSearch.value : '');
      timezoneModalOverlay.classList.add('visible');
      timezoneSearch?.focus();
    });
  }

  if (timezoneSearch) {
    timezoneSearch.addEventListener('input', () => {
      renderTimezoneList(timezoneSearch.value);
    });
  }

  if (timezoneSaveBtn && timezoneModalOverlay && electronAPI) {
    timezoneSaveBtn.addEventListener('click', async () => {
      const { effective, isSystem } = await electronAPI.setTimezone(selectedTimezoneValue);
      currentTimezoneInfo = { effective, isSystem };
      updateTimeTimezoneDisplay();
      timezoneCurrentLabel!.textContent = isSystem
        ? `Текущая: Системная таймзона (${effective})`
        : 'Текущая: ' + effective;
      timezoneModalOverlay.classList.remove('visible');
    });
  }

  if (timezoneCancelBtn && timezoneModalOverlay) {
    timezoneCancelBtn.addEventListener('click', () => {
      timezoneModalOverlay.classList.remove('visible');
    });
  }

  if (timezoneModalOverlay) {
    timezoneModalOverlay.addEventListener('click', (e) => {
      if (e.target === timezoneModalOverlay) {
        timezoneModalOverlay.classList.remove('visible');
      }
    });
  }
});

