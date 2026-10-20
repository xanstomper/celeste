import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Artifact, ChatMessage, PlanStep, TaskState } from '@celeste/protocol';
import { createId } from '@celeste/protocol';

/**
 * Persistent store for tasks.
 *
 * Every task is checkpointed after each step so a crash, a model switch or a
 * browser reload can be recovered from. Checkpoints are plain JSON on disk —
 * inspectable, diffable and trivially portable.
 */
export class TaskStore {
  private readonly tasks = new Map<string, TaskState>();
  private readonly dirty = new Set<string>();

  constructor(private readonly rootDir: string) {}

  /** Injects a task into the store (used when resuming from disk). */
  put(task: TaskState): void {
    this.tasks.set(task.id, task);
  }

  get(id: string): TaskState | undefined {
    return this.tasks.get(id);
  }

  list(): TaskState[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  create(
    title: string,
    focus?: TaskState['focus'],
    depth?: TaskState['depth'],
  ): TaskState {
    const now = Date.now();
    const task: TaskState = {
      id: createId('task'),
      title,
      ...(focus && focus !== 'web' ? { focus } : {}),
      ...(depth && depth !== 'quick' ? { depth } : {}),
      status: 'queued',
      plan: [],
      messages: [],
      scratch: {},
      artifacts: [],
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    this.markDirty(task.id);
    return task;
  }

  update(id: string, mutator: (task: TaskState) => void): TaskState | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    mutator(task);
    task.updatedAt = Date.now();
    this.markDirty(task.id);
    return task;
  }

  /** Adds an artifact and returns it. */
  addArtifact(id: string, artifact: Artifact): Artifact | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    task.artifacts.push(artifact);
    task.updatedAt = Date.now();
    this.markDirty(task.id);
    return artifact;
  }

  /** Replaces the plan. */
  setPlan(id: string, plan: PlanStep[]): void {
    this.update(id, (task) => {
      task.plan = plan;
    });
  }

  appendMessage(id: string, message: ChatMessage): void {
    this.update(id, (task) => {
      task.messages.push(message);
    });
  }

  private markDirty(id: string): void {
    this.dirty.add(id);
  }

  private fileFor(id: string): string {
    return path.join(this.rootDir, 'tasks', `${id}.json`);
  }

  /** Writes a checkpoint for a task. */
  async checkpoint(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) return;
    const file = this.fileFor(id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const payload = JSON.stringify(task, null, 2);
    await fs.writeFile(file, payload, 'utf8');
    this.dirty.delete(id);
  }

  /** Checkpoints every dirty task. */
  async checkpointAll(): Promise<void> {
    await Promise.all([...this.dirty].map((id) => this.checkpoint(id)));
  }

  /** Loads all checkpoints from disk into the store. */
  async load(): Promise<number> {
    const dir = path.join(this.rootDir, 'tasks');
    let files: string[] = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      return 0;
    }
    let count = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf8');
        const task = JSON.parse(raw) as TaskState;
        if (task?.id) {
          // A task that was mid-flight when the process died has no run
          // behind it any more. Leaving it "running" would make the panel
          // spin forever on work nobody is doing.
          if (task.status === 'running' || task.status === 'awaiting_approval') {
            task.status = 'failed';
            task.error = {
              code: 'CANCELLED',
              message: 'The daemon restarted while this task was running.',
              retryable: true,
            };
            task.updatedAt = Date.now();
            this.dirty.add(task.id);
          }
          this.tasks.set(task.id, task);
          count++;
        }
      } catch {
        // A corrupt checkpoint should never stop the daemon from booting.
      }
    }
    return count;
  }

  /** Deletes a task and its checkpoint. */
  async remove(id: string): Promise<void> {
    this.tasks.delete(id);
    this.dirty.delete(id);
    try {
      await fs.unlink(this.fileFor(id));
    } catch {
      /* already gone */
    }
  }
}
