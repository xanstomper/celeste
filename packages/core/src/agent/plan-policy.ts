import type { ResearchDepth } from '@celeste/protocol';

/**
 * Whether a task is worth planning.
 *
 * Planning costs a model round trip and a card in the thread. A one-line
 * question does not need either — the agent's first rule already sends it to
 * search, and the answer is the work. Multi-step jobs (comparisons, builds,
 * audits, anything that writes a file or walks a sequence) get a plan, and
 * research always does.
 *
 * This is deliberately conservative: a plan that should have been skipped is
 * a few seconds and some clutter, while a missing plan on a complex job is a
 * worse outcome.
 */
export function shouldPlan(prompt: string, depth?: ResearchDepth): boolean {
  if (depth === 'research') return true;

  const text = prompt.trim();
  if (text.length === 0) return false;
  if (text.length > 220) return true;

  const words = text.split(/\s+/).length;
  if (words > 30) return true;

  return /\b(?:and then|step by step|plan|compare|contrast|analyse|analyze|audit|investigate|report|build|create|write|save|download|fill|book|apply|collect|extract|scrape|list all|for each|every)\b/i.test(
    text,
  );
}
