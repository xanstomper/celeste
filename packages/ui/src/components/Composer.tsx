import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardEvent as ReactClipboardEvent, DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Attachment, ProviderSummary, SearchFocus } from '@celeste/protocol';

import { FocusPicker } from './FocusPicker';
import { Icon } from './Icon';
import { ProviderPicker } from './ProviderPicker';
import { hostOf } from '../lib/format';

export interface ComposerProps {
  providers: ProviderSummary[];
  activeProviderId: string | null;
  onProviderChange: (id: string) => void;
  autoApprove: boolean;
  onAutoApproveChange: (value: boolean) => void;
  /** Where a new task should research. */
  focus?: SearchFocus;
  onFocusChange?: (focus: SearchFocus) => void;
  /** The page currently open in the user's browser, for "ask about this page". */
  page?: { url?: string; title?: string } | null;
  /** Whether a new task should dig deeper and write a report. */
  research?: boolean;
  onResearchChange?: (value: boolean) => void;
  onSend: (content: string, attachments?: Attachment[]) => void | Promise<void>;
  busy?: boolean;
  hasSession: boolean;
  onCancel?: () => void;
  running?: boolean;
  /** `new` switches the composer into "start a new task" mode. */
  mode?: 'reply' | 'new';
  /** Bumping this token asks the composer to grab focus. */
  focusToken?: number;
  /**
   * Fills the composer with a suggestion.
   *
   * The empty state owns the starters, so it hands them over instead of
   * owning the field's value - the composer stays uncontrolled and does not
   * re-render the thread on every keystroke.
   */
  fill?: { text: string; token: number } | null;
}

const MAX_HEIGHT = 220;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * The task composer.
 *
 * Multi-line, Enter to send, Shift+Enter for a newline, plus the provider
 * picker, the auto-approve switch and image attachments. Images can be
 * picked, pasted or dropped; they travel with the message as content parts.
 */
export function Composer({
  providers,
  activeProviderId,
  onProviderChange,
  autoApprove,
  onAutoApproveChange,
  focus = 'web',
  onFocusChange,
  page = null,
  research = false,
  onResearchChange,
  onSend,
  busy = false,
  hasSession,
  onCancel,
  running = false,
  mode = 'reply',
  focusToken = 0,
  fill = null,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // "Ask about this page": the agent is told which page the reader means.
  const [usePage, setUsePage] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const startingNew = mode === 'new' || !hasSession;

  const activeProvider = providers.find((provider) => provider.id === activeProviderId);
  const blindModel = attachments.length > 0 && activeProvider?.supportsVision === false;

  const resize = useCallback(() => {
    const node = textareaRef.current;
    if (!node) return;
    if (!value.trim()) {
      node.style.height = '38px';
      return;
    }
    node.style.height = 'auto';
    const next = Math.max(38, Math.min(node.scrollHeight, MAX_HEIGHT));
    node.style.height = `${next}px`;
  }, [value]);

  useEffect(() => {
    resize();
  }, [resize, value]);

  useEffect(() => {
    if (focusToken === 0) return;
    textareaRef.current?.focus();
  }, [focusToken]);

  /* A suggestion handed over by the empty state lands in the field. */
  useEffect(() => {
    if (!fill || !fill.text) return;
    setValue(fill.text);
    textareaRef.current?.focus();
  }, [fill]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const images = [...files].filter((file) => file.type.startsWith('image/'));
    for (const file of images) {
      if (file.size > MAX_IMAGE_BYTES) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const comma = result.indexOf(',');
        if (comma < 0) return;
        const data = result.slice(comma + 1);
        setAttachments((current) =>
          current.length >= MAX_IMAGES
            ? current
            : [...current, { name: file.name || 'pasted image', mimeType: file.type, data }],
        );
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if ((!trimmed && attachments.length === 0) || busy) return;
    const outgoing = attachments;
    // With the page chip on, the agent is told exactly which page the
    // reader is talking about, so it does not have to guess.
    const context = usePage && page?.url
      ? `The page open in my browser is ${page.url}${page.title ? ` ("${page.title}")` : ''}.\n\n`
      : '';
    const message = context ? `${context}${trimmed}` : trimmed;
    setValue('');
    setAttachments([]);
    void onSend(message, outgoing.length > 0 ? outgoing : undefined);
  }, [attachments, busy, onSend, page, usePage, value]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = event.clipboardData?.files;
    if (files && files.length > 0) {
      event.preventDefault();
      addFiles(files);
    }
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };

  return (
    <div className="composer">
      {startingNew && onFocusChange ? (
        <div className="composer__modes">
          <FocusPicker value={focus} onChange={onFocusChange} disabled={busy} />
          {onResearchChange ? (
            <button
              type="button"
              role="switch"
              aria-checked={research}
              className={`focus__chip focus__chip--research${research ? ' focus__chip--active' : ''}`}
              onClick={() => onResearchChange(!research)}
              disabled={busy}
              title="Dig through many sources and write a structured report"
            >
              <Icon name="sparkle" size={13} />
              <span>Research</span>
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        className={`composer__shell${attachments.length > 0 ? ' composer__shell--attached' : ''}`}
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
      >
        {attachments.length > 0 ? (
          <div className="composer__attachments" aria-label="Attached images">
            {attachments.map((attachment, index) => (
              <figure className="attachment" key={`${attachment.name}-${index}`}>
                <img
                  src={`data:${attachment.mimeType};base64,${attachment.data}`}
                  alt={attachment.name}
                />
                <button
                  type="button"
                  className="attachment__remove"
                  onClick={() =>
                    setAttachments((current) => current.filter((_, at) => at !== index))
                  }
                  aria-label={`Remove ${attachment.name}`}
                  title="Remove image"
                >
                  <Icon name="x" size={10} />
                </button>
              </figure>
            ))}
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          className="composer__input"
          rows={1}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder="Ask anything…"
          aria-label={startingNew ? 'Describe a task' : 'Send a message'}
        />

        <div className="composer__toolbar">
          <div className="composer__left">
            <button
              type="button"
              className="composer__attach"
              onClick={() => fileRef.current?.click()}
              disabled={busy || attachments.length >= MAX_IMAGES}
              title="Attach images (or paste, or drop them here)"
              aria-label="Attach images"
            >
              <Icon name="paperclip" size={15} />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files) addFiles(event.target.files);
                event.target.value = '';
              }}
            />

            {page?.url ? (
              <button
                type="button"
                className={`composer__page${usePage ? ' composer__page--on' : ''}`}
                onClick={() => setUsePage((on) => !on)}
                title={
                  usePage
                    ? `Asking about ${page.title ?? page.url}`
                    : 'Ask about the page currently open in your browser'
                }
                aria-pressed={usePage}
              >
                <Icon name="globe" size={13} />
                <span className="composer__page-label">
                  {page.title ? page.title : hostOf(page.url)}
                </span>
              </button>
            ) : null}

            <ProviderPicker
              providers={providers}
              activeId={activeProviderId}
              onSwitch={onProviderChange}
              variant="compact"
              busy={busy}
              label="Task model provider"
            />

            <button
              type="button"
              role="switch"
              aria-checked={autoApprove}
              className={`composer__pill${autoApprove ? ' composer__pill--active' : ''}`}
              onClick={() => onAutoApproveChange(!autoApprove)}
              title="Automatically approve browser actions"
            >
              <Icon name="zap" size={12} />
              <span>{autoApprove ? 'Auto-approve ON' : 'Auto-approve'}</span>
            </button>
          </div>

          <div className="composer__right">
            {running && onCancel ? (
              <button
                type="button"
                className="composer__stop"
                onClick={() => void onCancel()}
                title="Stop task"
                aria-label="Stop task"
              >
                <Icon name="stop" size={13} />
                <span>Stop</span>
              </button>
            ) : null}

            <button
              type="button"
              className={`composer__send-circle${value.trim().length > 0 || attachments.length > 0 ? ' composer__send-circle--active' : ''}`}
              onClick={submit}
              disabled={busy || (value.trim().length === 0 && attachments.length === 0)}
              aria-label={startingNew ? 'Start task' : 'Send message'}
              title={startingNew ? 'Start task' : 'Send message'}
            >
              {busy ? <Icon name="spinner" size={16} /> : <Icon name="arrow-up" size={16} />}
            </button>
          </div>
        </div>
      </div>

      {blindModel ? (
        <p className="composer__warn">
          <Icon name="alert" size={11} />
          {activeProvider?.label ?? 'This model'} cannot read images — pick GLM, MiniMax or Qwen
          for vision.
        </p>
      ) : null}

      <p className="composer__hint">
        Celeste can make mistakes. Double-check important results.
      </p>
    </div>
  );
}
