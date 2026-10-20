import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ProviderSummary } from '@celeste/protocol';

import { Icon } from './Icon';
import { ProviderPicker } from './ProviderPicker';
import type { Settings, Theme } from '../state/useCeleste';

export interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  providers: ProviderSummary[];
  activeProviderId: string | null;
  onSwitchProvider: (id: string) => void;
  effectiveApiBase: string;
}

/**
 * The settings modal. Everything here is persisted to `localStorage`.
 */
export function SettingsPanel({
  open,
  onClose,
  settings,
  onChange,
  providers,
  activeProviderId,
  onSwitchProvider,
  effectiveApiBase,
}: SettingsPanelProps) {
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => firstFieldRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!open) return null;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <header className="modal__head">
          <h2 className="modal__title">
            <Icon name="settings" size={16} />
            Settings
          </h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close settings"
          >
            <Icon name="x" size={15} />
          </button>
        </header>

        <div className="modal__body">
          <section className="field-group">
            <h3 className="field-group__title">Output</h3>

            <label className="field">
              <span className="field__label">Output directory</span>
              <span className="field__control">
                <Icon name="folder" size={14} />
                <input
                  ref={firstFieldRef}
                  type="text"
                  value={settings.outputDir}
                  spellCheck={false}
                  onChange={(event) => onChange({ outputDir: event.target.value })}
                  placeholder="~/celeste-output"
                />
              </span>
              <span className="field__hint">Where generated documents and exports are written.</span>
            </label>

            <label className="field field--inline">
              <span className="field__label">Auto-approve risky actions</span>
              <button
                type="button"
                role="switch"
                aria-checked={settings.autoApprove}
                className={`toggle${settings.autoApprove ? ' toggle--on' : ''}`}
                onClick={() => onChange({ autoApprove: !settings.autoApprove })}
              >
                <span className="toggle__track">
                  <span className="toggle__thumb" />
                </span>
                <span className="toggle__label">
                  {settings.autoApprove ? 'Enabled' : 'Disabled'}
                </span>
              </button>
              <span className="field__hint">
                When off, Celeste pauses on anything irreversible and waits for you.
              </span>
            </label>
          </section>

          <section className="field-group">
            <h3 className="field-group__title">Browser extension</h3>

            <label className="field">
              <span className="field__label">Extension bridge port</span>
              <span className="field__control">
                <Icon name="wifi" size={14} />
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={settings.extensionPort}
                  onChange={(event) => onChange({ extensionPort: Number(event.target.value) || 0 })}
                />
              </span>
              <span className="field__hint">Local port the Celeste browser extension connects back on.</span>
            </label>
          </section>

          <section className="field-group">
            <h3 className="field-group__title">Connection</h3>

            <label className="field">
              <span className="field__label">Daemon URL</span>
              <span className="field__control">
                <Icon name="external" size={14} />
                <input
                  type="text"
                  value={settings.apiBase}
                  spellCheck={false}
                  placeholder={effectiveApiBase}
                  onChange={(event) => onChange({ apiBase: event.target.value })}
                />
              </span>
              <span className="field__hint">
                Leave empty to use <code>{effectiveApiBase}</code>.
              </span>
            </label>
          </section>

          <section className="field-group">
            <h3 className="field-group__title">Appearance</h3>
            <div className="segmented" role="radiogroup" aria-label="Theme">
              {(['dark', 'light'] as Theme[]).map((theme) => (
                <button
                  key={theme}
                  type="button"
                  role="radio"
                  aria-checked={settings.theme === theme}
                  className={`segmented__item${settings.theme === theme ? ' segmented__item--active' : ''}`}
                  onClick={() => onChange({ theme })}
                >
                  <Icon name={theme === 'dark' ? 'moon' : 'sun'} size={13} />
                  {theme === 'dark' ? 'Dark' : 'Light'}
                </button>
              ))}
            </div>
          </section>

          <section className="field-group">
            <h3 className="field-group__title">Model provider</h3>
            <ProviderPicker
              providers={providers}
              activeId={activeProviderId}
              onSwitch={onSwitchProvider}
              variant="panel"
              label="Active provider"
            />
          </section>
        </div>

        <footer className="modal__foot">
          <span className="modal__note">
            <Icon name="lock" size={12} />
            Preferences stay in this browser. Nothing is uploaded.
          </span>
          <button type="button" className="button button--primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
