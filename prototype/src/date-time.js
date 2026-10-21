const pad = value => String(value).padStart(2, '0');

// Keep the user-entered wall time intact; the evidence API interprets it as Beijing time.
export function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(year, month, 0).getDate();
}

export function validDateTime(date, time) {
  return validDate(date) && /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time);
}

export function dateWithinRange(date, min, max) {
  return validDate(date) && (!validDate(min) || date >= min) && (!validDate(max) || date <= max);
}

// Controls display Beijing wall time. Preserve the original timestamp (including
// seconds and its offset) when a user opens and confirms without changing it.
export function pickerParts(value = '') {
  if (validDate(value)) return { date: value, hour: '', minute: '' };
  if (/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const instant = new Date(value);
    if (!Number.isNaN(instant.getTime())) {
      const beijing = new Date(instant.getTime() + 8 * 60 * 60 * 1000).toISOString();
      return { date: beijing.slice(0, 10), hour: beijing.slice(11, 13), minute: beijing.slice(14, 16) };
    }
  }
  const [date = '', time = ''] = value.split('T');
  return { date, hour: time.slice(0, 2), minute: time.slice(3, 5) };
}

export function pickerValue({ original = '', date, hour, minute, includeTime, min, max }) {
  if (!dateWithinRange(date, min, max)) return null;
  if (!includeTime) return date;
  const time = `${hour}:${minute}`;
  if (!validDateTime(date, time)) return null;
  const prior = pickerParts(original);
  const originalTime = /T(\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.exec(original);
  if (originalTime && validDateTime(original.slice(0, 10), originalTime[1]) && prior.date === date && prior.hour === hour && prior.minute === minute) return original;
  return `${date}T${time}`;
}

export function calendarDays(year, month) {
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  const count = new Date(year, month + 1, 0).getDate();
  return [...Array(offset).fill(null), ...Array.from({ length: count }, (_, index) => `${year}-${pad(month + 1)}-${pad(index + 1)}`)];
}
