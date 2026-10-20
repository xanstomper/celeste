import { describe, expect, it } from 'vitest';
import { shouldPlan } from '../src/agent/plan-policy.js';

describe('shouldPlan', () => {
  it('skips the planner for a one-line question', () => {
    expect(shouldPlan('What is a pulsar?')).toBe(false);
    expect(shouldPlan('How do volcanoes work?')).toBe(false);
    expect(shouldPlan('Who won the 2024 Nobel prize in physics?')).toBe(false);
  });

  it('plans a multi-step job', () => {
    expect(shouldPlan('Compare the top three e-bikes and save a table')).toBe(true);
    expect(shouldPlan('Find every paper on X, read them, and write a report')).toBe(true);
    expect(shouldPlan('Fill in the form and download the receipt')).toBe(true);
  });

  it('always plans research, however short the question', () => {
    expect(shouldPlan('Microplastics?', 'research')).toBe(true);
  });

  it('plans a long prompt even without a keyword', () => {
    expect(
      shouldPlan(
        'I have been reading about the history of the telescope for weeks and I would like to understand how the designs changed between the 17th century and the modern reflecting instruments in some detail',
      ),
    ).toBe(true);
  });
});
