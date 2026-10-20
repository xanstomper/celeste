import { describe, expect, it } from 'vitest';
import { parseBlocks } from '../src/lib/markdown';

describe('parseBlocks', () => {
  it('parses headings instead of leaving literal hashes', () => {
    const blocks = parseBlocks('## What is dark energy?\n\nDark energy is [1].');

    expect(blocks[0]).toEqual({ kind: 'heading', level: 2, text: 'What is dark energy?' });
    expect(blocks[1]).toEqual({ kind: 'p', text: 'Dark energy is [1].' });
  });

  it('does not treat a hash without a space as a heading', () => {
    const blocks = parseBlocks('#not-a-heading');

    expect(blocks[0]?.kind).toBe('p');
  });

  it('ends a paragraph at a heading', () => {
    const blocks = parseBlocks('Intro line\n## Next\nBody');

    expect(blocks.map((block) => block.kind)).toEqual(['p', 'heading', 'p']);
  });

  it('clamps deeper levels to a heading block', () => {
    const blocks = parseBlocks('#### Deep');

    expect(blocks[0]).toEqual({ kind: 'heading', level: 4, text: 'Deep' });
  });
});
