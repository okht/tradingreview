import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDays, validDateTime, validDate, dateWithinRange, pickerParts, pickerValue } from '../src/date-time.js';

test('publication time requires a real date and explicit hour and minute', () => {
  for (const [date, time] of [['2024-02-29', '00:00'], ['2025-10-21', '23:59']]) assert.equal(validDateTime(date, time), true);
  for (const [date, time] of [['', ''], ['2025-10-21', ''], ['', '09:00'], ['2025-02-29', '09:00'], ['2025-04-31', '09:00'], ['2025-01-00', '09:00'], ['2025-13-01', '09:00'], ['2025-10-21', '24:00'], ['2025-10-21', '12:60']]) assert.equal(validDateTime(date, time), false);
});

test('calendar uses Monday as the first day and includes the complete leap month', () => {
  const leap = calendarDays(2024, 1);
  assert.deepEqual(leap.slice(0, 4), [null, null, null, '2024-02-01']);
  assert.equal(leap.at(-1), '2024-02-29');
  assert.equal(calendarDays(2025, 8)[0], '2025-09-01');
});

test('existing timestamps may retain seconds without accepting overflow', () => {
  assert.equal(validDateTime('2025-06-10', '09:45:30'), true);
  assert.equal(validDateTime('2025-06-10', '09:45:60'), false);
});

test('date-only entries stay date-only and validate inclusive range bounds', () => {
  assert.equal(validDate('2024-02-29'), true);
  assert.equal(validDate('2025-02-29'), false);
  assert.equal(dateWithinRange('2025-06-10', '2025-06-10', '2025-06-10'), true);
  assert.equal(dateWithinRange('2025-06-09', '2025-06-10'), false);
  assert.equal(pickerValue({ date: '2025-06-10', includeTime: false }), '2025-06-10');
  assert.equal(pickerValue({ date: '2025-06-10', includeTime: false, max: '2025-06-09' }), null);
  assert.equal(pickerValue({ date: '', includeTime: false }), null);
});

test('explicit time requires both selections without filling an assumed midnight', () => {
  const values = { date: '2025-06-10', includeTime: true };
  assert.equal(pickerValue({ ...values, hour: '', minute: '' }), null);
  assert.equal(pickerValue({ ...values, hour: '09', minute: '' }), null);
  assert.equal(pickerValue({ ...values, hour: '', minute: '45' }), null);
  assert.equal(pickerValue({ ...values, hour: '09', minute: '45' }), '2025-06-10T09:45');
  assert.equal(pickerValue({ ...values, hour: '00', minute: '00' }), '2025-06-10T00:00');
});

test('opening and confirming preserves imported seconds, milliseconds and offsets', () => {
  for (const original of ['2025-06-10T09:45:32', '2025-06-10T09:45:32.123+08:00', '2025-06-10T01:45:32Z']) {
    const parts = pickerParts(original);
    assert.deepEqual(parts, { date: '2025-06-10', hour: '09', minute: '45' });
    assert.equal(pickerValue({ original, ...parts, includeTime: true }), original);
    assert.equal(pickerValue({ original, ...parts, minute: '46', includeTime: true }), '2025-06-10T09:46');
  }
  assert.equal(pickerParts('2025-06-09T20:45Z').date, '2025-06-10');
});

test('removing specific time keeps the date and invalid seconds are not reused', () => {
  const original = '2025-06-10T09:45:31';
  assert.equal(pickerValue({ original, ...pickerParts(original), includeTime: false }), '2025-06-10');
  assert.equal(pickerValue({ original: '2025-06-10T09:45:99', date: '2025-06-10', hour: '09', minute: '45', includeTime: true }), '2025-06-10T09:45');
});
