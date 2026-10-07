import { describe, it, expect, beforeEach } from 'vitest';
import { on } from './state-bus.js';
import {
  beginExperience, endExperienceLink, rebaselineExperience, noteUrlWrite,
  activeExperienceId, experienceIsDirty,
} from './experience-link.js';

let dirtyEmits = 0;
on('exp:dirty', () => { dirtyEmits++; });

beforeEach(() => {
  endExperienceLink();
  dirtyEmits = 0;
});

describe('experience-link', () => {
  it('names nothing and notes nothing with no active story', () => {
    expect(activeExperienceId()).toBeNull();
    expect(noteUrlWrite('a=1')).toBe(false);
    expect(noteUrlWrite('a=2')).toBe(false);
    expect(experienceIsDirty()).toBe(false);
    expect(dirtyEmits).toBe(0);
  });

  it('records the first write as pristine and keeps an identical write named', () => {
    beginExperience('columbia-hydro');
    expect(noteUrlWrite('a=1')).toBe(true);
    expect(noteUrlWrite('a=1')).toBe(true);
    expect(experienceIsDirty()).toBe(false);
    expect(dirtyEmits).toBe(0);
  });

  it('turns dirty on a differing write, emits once, and stays dirty after a revert', () => {
    beginExperience('columbia-hydro');
    noteUrlWrite('a=1');
    expect(noteUrlWrite('a=2')).toBe(false);
    expect(experienceIsDirty()).toBe(true);
    expect(noteUrlWrite('a=3')).toBe(false);
    expect(noteUrlWrite('a=1')).toBe(false);
    expect(experienceIsDirty()).toBe(true);
    expect(dirtyEmits).toBe(1);
    expect(activeExperienceId()).toBe('columbia-hydro');
  });

  it('rebaseline makes the next write the new snapshot', () => {
    beginExperience('columbia-hydro');
    noteUrlWrite('a=1');
    rebaselineExperience();
    expect(noteUrlWrite('a=2')).toBe(true);
    expect(noteUrlWrite('a=2')).toBe(true);
    expect(experienceIsDirty()).toBe(false);
    expect(dirtyEmits).toBe(0);
  });

  it('rebaseline does not clear an edited story', () => {
    beginExperience('columbia-hydro');
    noteUrlWrite('a=1');
    noteUrlWrite('a=2');
    rebaselineExperience();
    expect(noteUrlWrite('a=2')).toBe(false);
    expect(experienceIsDirty()).toBe(true);
  });

  it('begin clears an earlier story’s snapshot and dirty flag', () => {
    beginExperience('columbia-hydro');
    noteUrlWrite('a=1');
    noteUrlWrite('a=2');
    beginExperience('interconnections-dc-seams');
    expect(activeExperienceId()).toBe('interconnections-dc-seams');
    expect(experienceIsDirty()).toBe(false);
    expect(noteUrlWrite('b=1')).toBe(true);
    expect(noteUrlWrite('b=1')).toBe(true);
  });

  it('end forgets the story without emitting', () => {
    beginExperience('columbia-hydro');
    noteUrlWrite('a=1');
    noteUrlWrite('a=2');
    endExperienceLink();
    expect(activeExperienceId()).toBeNull();
    expect(experienceIsDirty()).toBe(false);
    expect(noteUrlWrite('a=3')).toBe(false);
    expect(dirtyEmits).toBe(1);
  });
});
