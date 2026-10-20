/**
 * Tidies the final answer before the user sees it.
 *
 * Small models like to announce what they are about to do — "I have what I
 * need from the primary sources." — and then draw a horizontal rule. That is
 * a note to itself, not a reply, and no amount of prompt wording removes it
 * reliably. Removing it here is deterministic, cheap, and keeps the answer
 * looking like an answer.
 *
 * Only the *first* paragraph is ever considered, only when it is short, and
 * only when it matches a known narration pattern. A real opening sentence is
 * left alone.
 */

const NARRATION: RegExp[] = [
  /^I(?:'ve| have)(?: now)? (?:gathered|collected|compiled|got) (?:all )?(?:the |enough )?(?:information|sources|data|details)/i,
  /^I(?:'ve| have)(?: now)? (?:what I need|enough|sufficient)/i,
  /^I(?:'ve| have)(?: now)? (?:all|everything)\b/i,
  /^I now have (?:enough|what I need|sufficient|all)/i,
  /^I(?:'ve| have) (?:reviewed|read|checked) (?:the |all )?(?:sources|papers|results)/i,
  /^(?:Let me|Now let me|Let's) (?:summari[sz]e|write|put together|compile|organi[sz]e|answer|synthesi[sz]e)/i,
  /^(?:Great|Good|Perfect|Excellent|Okay|OK|Alright|Sure)[,.!]/i,
  /^Based on (?:the|my) (?:research|sources|findings|searches)\b[^.]*\.?$/i,
  /^(?:Here(?:'s| is)) (?:what|a summary of what) I found\b[^.]*\.?$/i,
];

/** The first paragraph, plus the rest of the text after it. */
function splitFirstParagraph(text: string): [string, string] {
  const match = /\n\s*\n/.exec(text);
  if (!match) return [text, ''];
  return [text.slice(0, match.index), text.slice(match.index + match[0].length)];
}

/**
 * A note about the research itself, rather than an answer.
 *
 * Only trusted when the text that follows opens with a heading: that proves
 * the model has a structured answer and this paragraph was throat-clearing
 * in front of it. Without that signal, a sentence about "the data" might be
 * the answer, and is left alone.
 */
function isProcessNote(paragraph: string, rest: string): boolean {
  const line = paragraph.trim();
  if (line.length === 0 || line.length > 400) return false;
  if (!/(?:search|fetch|source|abstract|article|literature|pdf|results?|pages?|read)/i.test(line)) {
    return false;
  }
  return /^(?:-{3,}\s*\n+)?#{1,6}\s/.test(rest.trim());
}

function isNarration(paragraph: string): boolean {
  // "Good, I have gathered…" is the same preamble as "I have gathered…".
  const line = paragraph
    .trim()
    .replace(/^(?:Great|Good|Perfect|Excellent|Okay|OK|Alright|Sure)[,.!]\s*/i, '');
  if (line.length === 0 || line.length > 300) return false;
  return NARRATION.some((pattern) => pattern.test(line));
}

/**
 * A short opening note about doing the research, rather than an answer.
 *
 * Models produce these in many shapes — "I have strong material…", "The
 * user's question is conversational, so I'll answer in chat…", "Based on my
 * research, here's what…". They share a signature: a short paragraph that
 * opens in the first person (or about "the user") and talks about the work
 * rather than the subject.
 */
function isResearchNote(paragraph: string, rest: string): boolean {
  const line = paragraph.trim();
  if (line.length === 0 || line.length > 400) return false;
  if (!/^(?:I\b|I've\b|The user\b|Based on\b|Here's\b|Here is\b|Let me\b|Now\b|Alright\b)/i.test(line)) {
    return false;
  }
  if (
    !/\b(?:research|sources?|searches|searching|material|synthesi[sz]e|summari[sz]e|covered|citations?|original question|user's question|answer in chat|creating a file)\b/i.test(
      line,
    )
  ) {
    return false;
  }
  // Never strip the last thing in the message.
  return rest.trim().length > 0;
}

/**
 * Drops everything before the first heading when the text in front of it is
 * notes about the research rather than part of the answer.
 *
 * Research answers often open with a paragraph listing the papers the model
 * read, then "Here is my research summary:", then the report. The heading is
 * the real start; the paragraph is a receipt. Only stripped when the preamble
 * is short and talks about the work in the first person, so a real opening
 * paragraph survives.
 */
function stripBeforeFirstHeading(text: string): string {
  const heading = /^#{1,6}\s/m.exec(text);
  if (!heading || heading.index === 0) return text;

  const before = text.slice(0, heading.index);
  if (before.length > 900) return text;

  const firstPerson = /\b(?:I|I've|I'm|my|we|we've)\b/i.test(before);
  const researchy =
    /\b(?:research|sources?|searches|searched|searching|evidence base|papers?|studies|read|gathered|synthesi[sz]e|summari[sz]e)\b/i.test(
      before,
    );

  return firstPerson && researchy ? text.slice(heading.index) : text;
}

export function cleanAnswer(input: string): string {
  let text = input.trim();

  // Some models open with a rule even without a preamble.
  text = text.replace(/^-{3,}\s*\n+/, '').trim();
  text = stripBeforeFirstHeading(text);

  // Models sometimes stack three of these before the answer starts.
  for (let pass = 0; pass < 4; pass++) {
    const [first, rest] = splitFirstParagraph(text);
    if (!isNarration(first) && !isProcessNote(first, rest) && !isResearchNote(first, rest)) break;

    // Never strip the answer down to nothing.
    if (rest.trim().length === 0) break;

    text = rest.trim().replace(/^-{3,}\s*\n+/, '').trim();
  }

  return text;
}
