import type { TaskState } from '@celeste/protocol';

/**
 * A thread as Markdown.
 *
 * People want to take a conversation somewhere else - into a note, a
 * document, a ticket. This is the whole thread: what was asked, what was
 * answered, the sources that were read and the files that were produced.
 */
export function threadToMarkdown(task: TaskState): string {
  const lines: string[] = [];

  lines.push(`# ${task.title || 'Conversation'}`);
  lines.push('');
  lines.push(
    `_${new Date(task.createdAt).toLocaleString()}_ · ${task.status}${
      task.focus && task.focus !== 'web' ? ` · focus: ${task.focus}` : ''
    }${task.depth && task.depth !== 'quick' ? ` · ${task.depth}` : ''}`,
  );
  lines.push('');

  for (const message of task.messages) {
    const text = messageText(message);
    if (!text.trim()) continue;

    if (message.role === 'user') {
      lines.push('## You');
      lines.push('');
      lines.push(text);
      lines.push('');
      continue;
    }
    if (message.role === 'tool') continue;

    lines.push(`## Celeste${message.name ? ` (${message.name})` : ''}`);
    lines.push('');
    lines.push(text);
    lines.push('');

    const toolCalls = message.toolCalls ?? [];
    if (toolCalls.length > 0) {
      lines.push('### What it did');
      lines.push('');
      for (const call of toolCalls) {
        lines.push(`- **${call.name}**${call.arguments ? ` — \`${call.arguments}\`` : ''}`);
      }
      lines.push('');
    }
  }

  const sources = task.sources ?? [];
  if (sources.length > 0) {
    lines.push('## Sources');
    lines.push('');
    for (const source of sources) {
      lines.push(`${source.n}. [${source.title}](${source.url}) — ${source.domain}`);
    }
    lines.push('');
  }

  if (task.artifacts.length > 0) {
    lines.push('## Files');
    lines.push('');
    for (const artifact of task.artifacts) {
      lines.push(`- ${artifact.path} (${artifact.kind})`);
    }
    lines.push('');
  }

  if (task.canvas) {
    lines.push('## Canvas');
    lines.push('');
    lines.push(`_${task.canvas.title} (${task.canvas.kind})_`);
    lines.push('');
  }

  return lines.join('\n');
}

function messageText(message: { content: string | { type: string; text?: string }[] }): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => ('text' in part ? (part.text ?? '') : ''))
    .join('\n');
}

/** A file name that is safe to write. */
export function threadFileName(task: TaskState): string {
  const slug = (task.title || 'conversation')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `celeste-${slug || 'conversation'}.md`;
}
