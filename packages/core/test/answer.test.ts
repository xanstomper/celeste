import { describe, expect, it } from 'vitest';
import { cleanAnswer } from '../src/agent/answer.js';

describe('cleanAnswer', () => {
  it('drops a preamble and the rule that follows it', () => {
    const input = `I have what I need from the primary sources. The two papers give the core findings.

---

## What the telescope found

The shadow is 42 microarcseconds across [1].`;

    expect(cleanAnswer(input)).toBe(
      '## What the telescope found\n\nThe shadow is 42 microarcseconds across [1].',
    );
  });

  it('drops a preamble that opens with an interjection', () => {
    const input = `Good, I have gathered enough data from the searches and article excerpts. Let me now synthesize the current state of the research.

---

## The Hubble tension

The discrepancy is between measurements of the expansion rate [2].`;

    expect(cleanAnswer(input)).toBe(
      '## The Hubble tension\n\nThe discrepancy is between measurements of the expansion rate [2].',
    );
  });

  it('drops "I have all the information I need"', () => {
    const input = `I have all the information I need. Let me write up the answer.

## The Hubble tension

The tension has hardened [1].`;

    expect(cleanAnswer(input)).toBe(
      '## The Hubble tension\n\nThe tension has hardened [1].',
    );
  });

  it('drops a note about the research when a heading follows', () => {
    const input = `The PDF full-text fetches returned empty, but the abstracts plus the full article text I already read give me the key numbers. Here is what the literature says.

## The Hubble tension

The discrepancy is between measurements of the expansion rate [2].`;

    expect(cleanAnswer(input)).toBe(
      '## The Hubble tension\n\nThe discrepancy is between measurements of the expansion rate [2].',
    );
  });

  it('keeps a sentence about the data when no heading follows', () => {
    const input = `The data shows a discrepancy between the two measurements [2].

The difference is about 5 sigma.`;

    expect(cleanAnswer(input)).toBe(input);
  });

  it('drops several stacked research notes', () => {
    const input = `I have strong material to answer this comprehensively. Let me synthesize what I've found from my research. I've covered two of the key themes, and I have enough to give a solid answer.

The user's original question is conversational, so I'll answer in chat with citations rather than creating a file.

Based on my research, here's what JWST has revealed about the early universe:

## What JWST has revealed

Galaxies formed earlier than expected [1].`;

    expect(cleanAnswer(input)).toBe(
      '## What JWST has revealed\n\nGalaxies formed earlier than expected [1].',
    );
  });

  it('drops a "let me" line', () => {
    const input = `Let me summarise the findings.

The ring is brighter on one side [2].`;

    expect(cleanAnswer(input)).toBe('The ring is brighter on one side [2].');
  });

  it('drops a leading horizontal rule even without a preamble', () => {
    expect(cleanAnswer('---\n\nThe answer is 42 [1].')).toBe('The answer is 42 [1].');
  });

  it('leaves a real opening sentence alone', () => {
    const input = `The Event Horizon Telescope published the first image of a black hole in 2019 [1].

The ring is brighter on one side.`;

    expect(cleanAnswer(input)).toBe(input);
  });

  it('keeps the text when the preamble is all there is', () => {
    const input = 'I have what I need.';
    expect(cleanAnswer(input)).toBe(input);
  });
});
