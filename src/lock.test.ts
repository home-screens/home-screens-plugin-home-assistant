import { describe, expect, it } from 'vitest';
import { lockNeedsCode, lockService, lockActionLabel } from './lock';
import type { HAStateObject } from './types';

function lock(state: string, attributes: Record<string, unknown> = {}): HAStateObject {
  return {
    entity_id: 'lock.front_door', state,
    attributes: { friendly_name: 'Front Door', ...attributes },
    last_changed: '2026-07-01T00:00:00Z', last_updated: '2026-07-01T00:00:00Z',
  };
}

describe('lockNeedsCode', () => {
  it('is true only for a non-empty code_format', () => {
    expect(lockNeedsCode(lock('locked', { code_format: '\\d{4}' }))).toBe(true);
    expect(lockNeedsCode(lock('locked', { code_format: '' }))).toBe(false);
    expect(lockNeedsCode(lock('locked'))).toBe(false);
  });
});

describe('lockService', () => {
  it('flips the settled states', () => {
    expect(lockService(lock('locked'))).toBe('unlock');
    expect(lockService(lock('unlocked'))).toBe('lock');
  });

  it('offers nothing mid-motion, when jammed, or when a code is required', () => {
    expect(lockService(lock('locking'))).toBeNull();
    expect(lockService(lock('unlocking'))).toBeNull();
    expect(lockService(lock('jammed'))).toBeNull();
    expect(lockService(lock('unavailable'))).toBeNull();
    expect(lockService(lock('locked', { code_format: '\\d{4}' }))).toBeNull();
  });
});

describe('lockActionLabel', () => {
  it('names the action a hold would run', () => {
    expect(lockActionLabel(lock('locked'))).toBe('Hold to unlock');
    expect(lockActionLabel(lock('unlocked'))).toBe('Hold to lock');
    expect(lockActionLabel(lock('jammed'))).toBeNull();
  });
});
