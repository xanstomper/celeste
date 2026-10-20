import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ProviderSummary } from '@celeste/protocol';

import { Icon } from './Icon';
import { ProviderPicker } from './ProviderPicker';

export interface ComposerProps {
  providers: ProviderSummary[];
  activeProviderId: string | null;
  onProviderChange: (id: string) => void;
  autoApprove: boolean;
  onAutoApproveChange: (value: boolean) => void;
  onSend: (content: string) => void | Promise<void>;
  busy?: boolean;
  hasSession: boolean;
  onCancel?: () => void;
  running?: boolean;
  /** `new` switches the composer into "start a new task" mode. */
  mode?: 'reply' | 'new';
  /** Bumping this token asks the composer to grab focus. */
  focusToken?: number;
}

const MAX_HEIGHT = 220;

/**
 * The task composer.
 *
 * Multi-line, Enter to send, Shift+Enter for a newline, plus the provider
 * picker and the auto-approve switch.
 */
export function Composer({
  providers,
  activeProviderId,
  onProviderChange,
  autoApprove,
  onAutoApproveChange,
  onSend,
  busy = false,
  hasSession,
  onCancel,
  running = false,
  mode = 'reply',
  focusToken = 0,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const startingNew = mode === 'new' || !hasSession;

  const resize = useCallback(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [resize, value]);

  useEffect(() => {
    if (focusToken === 0) return;
    textareaRef.current?.focus();
  }, [focusToken]);

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setValue('');
    void onSend(trimmed);
  }, [busy, onSend, value]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      <div className="composer__shell">
        <textarea
          ref={textareaRef}
          className="composer__input"
          rows={1}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            startingNew
              ? 'Describe what you want Celeste to do in your browser…  (Enter to send)'
              : 'Reply, or add the next instruction…  (Enter to send, Shift+Enter for a new line)'
          }
          aria-label={startingNew ? 'Describe a task' : 'Send a message'}
        />

        <div className="composer__toolbar">
          <div className="composer__left">
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
              className={`toggle${autoApprove ? ' toggle--on' : ''}`}
              onClick={() => onAutoApproveChange(!autoApprove)}
              title="Automatically approve risky tool calls"
            >
              <span className="toggle__track">
                <span className="toggle__thumb" />
              </span>
              <span className="toggle__label">
                <Icon name="zap" size={12} />
                Auto-approve risky actions
              </span>
            </button>
          </div>

          <div className="composer__right">
            {running && onCancel ? (
              <button type="button" className="button button--ghost" onClick={() => void onCancel()}>
                <Icon name="stop" size={13} />
                Stop
              </button>
            ) : null}

            <button
              type="button"
              className="button button--primary composer__send"
              onClick={submit}
              disabled={busy || value.trim().length === 0}
              aria-label={startingNew ? 'Start task' : 'Send message'}
            >
              {busy ? <Icon name="spinner" size={15} /> : <Icon name="send" size={15} />}
              <span>{busy ? 'Working' : startingNew ? 'Start task' : 'Send'}</span>
            </button>
          </div>
        </div>
      </div>

      <p className="composer__hint">
        <Icon name="lock" size={11} />
        Runs locally · zero telemetry · nothing leaves your machine without your approval
      </p>
    </div>
  );
}
