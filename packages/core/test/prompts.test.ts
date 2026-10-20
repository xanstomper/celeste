import { describe, expect, it } from 'vitest';
import { depthGuidance, focusGuidance } from '../src/agent/prompts.js';

describe('focus and depth guidance', () => {
  it('says nothing for the default web/quick task', () => {
    expect(focusGuidance('web')).toBe('');
    expect(focusGuidance(undefined)).toBe('');
    expect(depthGuidance('quick')).toBe('');
    expect(depthGuidance(undefined)).toBe('');
  });

  it('asks an academic task for papers and dates', () => {
    const guidance = focusGuidance('academic');
    expect(guidance).toContain('arXiv');
    expect(guidance).toContain('year');
  });

  it('asks a news task for recent, dated events', () => {
    const guidance = focusGuidance('news');
    expect(guidance).toContain('dated headlines');
    expect(guidance).toContain('most recent');
  });

  it('asks a research task for a structured report', () => {
    const guidance = depthGuidance('research');
    expect(guidance).toContain('six sources');
    expect(guidance).toContain('headed sections');
    expect(guidance).toContain('uncertain');
  });
});
