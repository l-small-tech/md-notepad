import { describe, expect, test } from 'vitest';
import { errorDetail, withErrorDetail } from '../error-text';

describe('errorDetail', () => {
  test('reads an Error message, trimmed', () => {
    expect(errorDetail(new Error('  io error: denied \n'))).toBe('io error: denied');
  });
  test('accepts a thrown string', () => {
    expect(errorDetail(' boom ')).toBe('boom');
  });
  test('anything else has no detail', () => {
    expect(errorDetail(undefined)).toBe('');
    expect(errorDetail(null)).toBe('');
    expect(errorDetail({ code: 'IO' })).toBe('');
    expect(errorDetail(new Error(''))).toBe('');
  });
});

describe('withErrorDetail', () => {
  test('appends the detail after a colon', () => {
    expect(withErrorDetail('Could not move "a.md"', new Error('io error: locked'))).toBe(
      'Could not move "a.md": io error: locked',
    );
  });
  test('closes the lead as a sentence when there is no detail', () => {
    expect(withErrorDetail('Could not move "a.md"', 42)).toBe('Could not move "a.md".');
  });
});
