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
  removeAlarmsUpdatedListener: () => void;
  removeAlarmTriggeredListener: () => void;
}

let alarms: Alarm[] = [];
let editingAlarmId: string | null = null;
let audioContext: AudioContext | null = null;
let audioInterval: NodeJS.Timeout | null = null;
let isAlarmPlaying: boolean = false;
let alarmNotification: Notification | null = null;
let timeUpdateInterval: NodeJS.Timeout | null = null;

function generateAlarmId(): string {
  return `alarm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function formatTime(hour: number, minute: number, second: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

function getTimeUntilAlarm(alarm: Alarm): number {
  const now = new Date();
  const alarmTime = new Date();
  alarmTime.setHours(alarm.hour, alarm.minute, alarm.second, 0);
  
  // Если время будильника уже прошло сегодня, берем завтрашний день
  if (alarmTime <= now) {
    alarmTime.setDate(alarmTime.getDate() + 1);
  }
  
  return Math.floor((alarmTime.getTime() - now.getTime()) / 1000);
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
        inputToFocus.focus();
        // Восстанавливаем позицию курсора
        const cursorPos = (editingValues as any).cursorPosition;
        if (cursorPos !== null && cursorPos !== undefined) {
          inputToFocus.setSelectionRange(cursorPos, cursorPos);
        }
      }
    }, 0);
  }
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
      if (audioContext && isAlarmPlaying && alarmNotification) {
        playBeep();
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

    // Останавливаем звук и мигание когда уведомление закрыто
    alarmNotification.onclose = () => {
      dismissAlarm();
    };

    // Останавливаем звук и мигание при клике на уведомление
    alarmNotification.onclick = () => {
      dismissAlarm();
      if (window.focus) window.focus();
    };
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

// Инициализация при загрузке страницы
document.addEventListener('DOMContentLoaded', () => {
  // Запрашиваем разрешение на уведомления при загрузке
  if (Notification.permission === 'default') {
    Notification.requestPermission();
  }

  const electronAPI = (window as any).electronAPI as ElectronAPI | undefined;
  if (electronAPI) {
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
  }

  // Обработка Enter в полях ввода
  const hourInput = document.getElementById('newHour') as HTMLInputElement;
  const minuteInput = document.getElementById('newMinute') as HTMLInputElement;
  const secondInput = document.getElementById('newSecond') as HTMLInputElement;
  const addBtn = document.getElementById('addAlarmBtn');

  if (hourInput) {
    hourInput.addEventListener('keypress', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        minuteInput?.focus();
      }
    });
  }

  if (minuteInput) {
    minuteInput.addEventListener('keypress', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        secondInput?.focus();
      }
    });
  }

  if (secondInput) {
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
  const minimizeBtn = document.getElementById('minimizeBtn');
  const closeBtn = document.getElementById('closeBtn');

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
});

