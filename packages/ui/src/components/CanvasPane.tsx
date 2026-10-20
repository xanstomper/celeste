import { useMemo, useState } from 'react';
import type { CanvasKind, CanvasState } from '@celeste/protocol';
import { Markdown } from '../lib/markdown';
import { Icon } from './Icon';

export interface CanvasPaneProps {
  canvas: CanvasState | null;
  onClose: () => void;
  onAsk?: (prompt: string) => void;
}

const KIND_META: Record<CanvasKind, { label: string; icon: 'file' | 'sparkle' | 'image' | 'folder' }> = {
  document: { label: 'Document', icon: 'file' },
  visual: { label: 'Visual App', icon: 'sparkle' },
  image: { label: 'Image', icon: 'image' },
  project: { label: 'Project Scaffold', icon: 'folder' },
};

const STARTERS = [
  'Build an interactive dashboard of key findings',
  'Turn this into a visual report with charts',
  'Make a diagram explaining how this works',
  'Scaffold a runnable project for this architecture',
];

const EDIT_PILLS = [
  'Add interactive charts',
  'Apply sleek dark theme',
  'Add executive summary',
  'Add comparison matrix',
];

function download(name: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function safeName(title: string, extension: string): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'canvas';
  return `${base}.${extension}`;
}

function ProjectView({ canvas }: { canvas: CanvasState }) {
  const files = canvas.files ?? [];
  const [selected, setSelected] = useState(0);
  const file = files[Math.min(selected, Math.max(0, files.length - 1))];

  if (!file) return <p className="canvas__empty">This project canvas has no files.</p>;

  return (
    <div className="canvas__project">
      <nav className="canvas__files" aria-label="Project files">
        {files.map((entry, index) => (
          <button
            type="button"
            key={entry.path}
            className={`canvas__file${index === selected ? ' canvas__file--active' : ''}`}
            onClick={() => setSelected(index)}
            title={entry.path}
          >
            <Icon name="file" size={12} />
            <span>{entry.path}</span>
          </button>
        ))}
      </nav>
      <div className="canvas__code">
        <div className="canvas__code-head">
          <span>{file.path}</span>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => void navigator.clipboard.writeText(file.content).catch(() => undefined)}
          >
            <Icon name="copy" size={12} />
            Copy
          </button>
        </div>
        <pre>{file.content}</pre>
      </div>
    </div>
  );
}

export function CanvasPane({ canvas, onClose, onAsk }: CanvasPaneProps) {
  const [viewMode, setViewMode] = useState<'preview' | 'code' | 'split'>('preview');
  const [editPrompt, setEditPrompt] = useState('');
  const meta = canvas ? KIND_META[canvas.kind] : null;
  const stamp = useMemo(
    () => (canvas ? new Date(canvas.updatedAt).toLocaleTimeString() : ''),
    [canvas],
  );

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = editPrompt.trim();
    if (!text || !onAsk) return;
    onAsk(`In the canvas "${canvas?.title ?? 'current canvas'}", ${text}`);
    setEditPrompt('');
  };

  const wordCount = useMemo(() => {
    if (!canvas?.content) return 0;
    return canvas.content.split(/\s+/).filter(Boolean).length;
  }, [canvas?.content]);

  return (
    <section className="canvas-pane" aria-label="Canvas Workspace">
      <header className="canvas-pane__head">
        <div className="canvas-pane__head-left">
          <span className="canvas-pane__kind">
            <Icon name={meta?.icon ?? 'sparkle'} size={14} />
            {meta?.label ?? 'Canvas'}
          </span>
          <h2 className="canvas-pane__title" title={canvas?.title}>
            {canvas?.title ?? 'Canvas Workspace'}
          </h2>
        </div>

        {/* View Mode Switcher for visual/document canvases */}
        {canvas && (canvas.kind === 'visual' || canvas.kind === 'document') ? (
          <div className="canvas-pane__view-toggle">
            <button
              type="button"
              className={`toggle-tab${viewMode === 'preview' ? ' toggle-tab--active' : ''}`}
              onClick={() => setViewMode('preview')}
            >
              Preview
            </button>
            <button
              type="button"
              className={`toggle-tab${viewMode === 'code' ? ' toggle-tab--active' : ''}`}
              onClick={() => setViewMode('code')}
            >
              Code
            </button>
            {canvas.kind === 'visual' ? (
              <button
                type="button"
                className={`toggle-tab${viewMode === 'split' ? ' toggle-tab--active' : ''}`}
                onClick={() => setViewMode('split')}
              >
                Split
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="canvas-pane__actions">
          {canvas && (
            <span className="canvas-pane__meta-pill">
              {wordCount > 0 ? `${wordCount} words · ` : ''}updated {stamp}
            </span>
          )}

          {canvas && canvas.kind === 'document' ? (
            <button
              type="button"
              className="button button--ghost"
              onClick={() => download(safeName(canvas.title, 'md'), canvas.content, 'text/markdown')}
            >
              <Icon name="file" size={13} />
              Export
            </button>
          ) : null}

          {canvas && canvas.kind === 'visual' ? (
            <button
              type="button"
              className="button button--ghost"
              onClick={() => download(safeName(canvas.title, 'html'), canvas.content, 'text/html')}
            >
              <Icon name="file" size={13} />
              Export HTML
            </button>
          ) : null}

          {canvas && canvas.kind === 'image' ? (
            <a
              className="button button--ghost"
              href={canvas.content}
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="external" size={13} />
              Open
            </a>
          ) : null}

          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close canvas"
            title="Close canvas"
          >
            <Icon name="x" size={15} />
          </button>
        </div>
      </header>

      <div className="canvas-pane__body">
        {!canvas ? (
          <div className="canvas__blank">
            <span className="canvas__blank-icon">
              <Icon name="sparkle" size={28} />
            </span>
            <h3>Build beside the conversation</h3>
            <p>
              ChatGPT Canvas meets Perplexity Pages: live interactive HTML dashboards, diagrams,
              rich markdown reports, and multi-file projects generated by Celeste.
            </p>
            <div className="canvas__starters">
              {STARTERS.map((starter) => (
                <button
                  type="button"
                  key={starter}
                  className="canvas__starter"
                  onClick={() => onAsk?.(starter)}
                  disabled={!onAsk}
                >
                  <Icon name="plus" size={12} />
                  {starter}
                </button>
              ))}
            </div>
          </div>
        ) : canvas.kind === 'document' ? (
          viewMode === 'code' ? (
            <div className="canvas__code">
              <div className="canvas__code-head">
                <span>Markdown Source</span>
                <button
                  type="button"
                  className="button button--ghost button--sm"
                  onClick={() => void navigator.clipboard.writeText(canvas.content).catch(() => undefined)}
                >
                  <Icon name="copy" size={12} /> Copy
                </button>
              </div>
              <pre>{canvas.content}</pre>
            </div>
          ) : (
            <article className="canvas__document">
              <Markdown content={canvas.content} className="bubble__text--prose" />
            </article>
          )
        ) : canvas.kind === 'visual' ? (
          viewMode === 'code' ? (
            <div className="canvas__code">
              <div className="canvas__code-head">
                <span>HTML/CSS/JS Source</span>
                <button
                  type="button"
                  className="button button--ghost button--sm"
                  onClick={() => void navigator.clipboard.writeText(canvas.content).catch(() => undefined)}
                >
                  <Icon name="copy" size={12} /> Copy
                </button>
              </div>
              <pre>{canvas.content}</pre>
            </div>
          ) : viewMode === 'split' ? (
            <div className="canvas__split">
              <div className="canvas__split-pane canvas__split-pane--code">
                <div className="canvas__code-head">
                  <span>Source</span>
                </div>
                <pre>{canvas.content}</pre>
              </div>
              <div className="canvas__split-pane canvas__split-pane--preview">
                <iframe
                  className="canvas__frame"
                  title={canvas.title}
                  srcDoc={canvas.content}
                  sandbox="allow-scripts allow-forms allow-modals allow-popups"
                />
              </div>
            </div>
          ) : (
            <iframe
              className="canvas__frame"
              title={canvas.title}
              srcDoc={canvas.content}
              sandbox="allow-scripts allow-forms allow-modals allow-popups"
            />
          )
        ) : canvas.kind === 'image' ? (
          <figure className="canvas__image">
            <img src={canvas.content} alt={canvas.title} />
            <figcaption>
              <span>{canvas.title}</span>
              <span className="canvas__stamp">updated {stamp}</span>
            </figcaption>
          </figure>
        ) : (
          <ProjectView canvas={canvas} />
        )}
      </div>

      {/* Direct Canvas Editing Bar (ChatGPT Canvas style) */}
      {canvas && onAsk ? (
        <footer className="canvas-pane__footer">
          <div className="canvas-pane__pills">
            {EDIT_PILLS.map((pill) => (
              <button
                type="button"
                key={pill}
                className="canvas-pill"
                onClick={() => onAsk(`In the canvas "${canvas.title}", ${pill.toLowerCase()}`)}
              >
                {pill}
              </button>
            ))}
          </div>
          <form className="canvas-pane__composer" onSubmit={handleEditSubmit}>
            <input
              type="text"
              className="canvas-pane__input"
              value={editPrompt}
              onChange={(e) => setEditPrompt(e.target.value)}
              placeholder="Ask Celeste to edit or expand this canvas…"
            />
            <button
              type="submit"
              className="button button--accent button--sm"
              disabled={!editPrompt.trim()}
            >
              <Icon name="sparkle" size={13} />
              Update
            </button>
          </form>
        </footer>
      ) : null}
    </section>
  );
}
