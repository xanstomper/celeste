import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@celeste/protocol';
import { parseSuggestions } from '../src/daemon/server.js';

function reply(content: string): ChatMessage {
  return { role: 'assistant', content };
}

describe('parseSuggestions', () => {
  it('reads a plain list of questions', () => {
    const questions = parseSuggestions(
      reply(
        'What would a higher Hubble constant mean for dark energy?\n' +
          'How do gravitational-wave measurements compare with the distance ladder?\n' +
          'Which survey will settle the tension first?',
      ),
    );

    expect(questions).toHaveLength(3);
    expect(questions[0]).toBe('What would a higher Hubble constant mean for dark energy?');
  });

  it('accepts questions that lost their question mark', () => {
    const questions = parseSuggestions(
      reply('How precise is the latest SH0ES measurement\nWhy do early-universe fits disagree'),
    );

    expect(questions).toEqual([
      'How precise is the latest SH0ES measurement?',
      'Why do early-universe fits disagree?',
    ]);
  });

  it('reads a JSON array', () => {
    const questions = parseSuggestions(
      reply('["What is the Hubble tension?", "How is it measured?", "Will new telescopes resolve it?"]'),
    );

    expect(questions).toEqual([
      'What is the Hubble tension?',
      'How is it measured?',
      'Will new telescopes resolve it?',
    ]);
  });

  it('ignores a preamble and non-question lines', () => {
    const questions = parseSuggestions(
      reply(
        'Questions:\n' +
          'The tension is important.\n' +
          'What does the James Webb telescope add?',
      ),
    );

    expect(questions).toEqual(['What does the James Webb telescope add?']);
  });

  it('caps the list at three', () => {
    const questions = parseSuggestions(
      reply(
        'Why is the tension growing?\n' +
          'Why do the measurements disagree?\n' +
          'Which survey will settle it?\n' +
          'What happens if the tension is real?',
      ),
    );

    expect(questions).toHaveLength(3);
  });
});
