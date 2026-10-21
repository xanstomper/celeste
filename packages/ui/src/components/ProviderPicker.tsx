import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ProviderSummary } from '@celeste/protocol';

import { Icon } from './Icon';

export interface ProviderPickerProps {
  providers: ProviderSummary[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  /**
   * - `compact` - a dropdown button for the composer.
   * - `panel`   - the full list, for the settings modal.
   * - `pill`    - the header's model pill: the model id, nothing else.
   */
  variant?: 'compact' | 'panel' | 'pill';
  busy?: boolean;
  label?: string;
}

function providerKeyBadge(provider: ProviderSummary) {
  if (provider.id === 'pollinations') {
    return (
      <span className="chip chip--ok" title="No account or key needed">
        <Icon name="sparkle" size={10} />
        keyless
      </span>
    );
  }
  if (provider.hasKey) {
    return (
      <span className="chip chip--ok" title="An API key was resolved for this provider">
        <Icon name="lock" size={10} />
        key ready
      </span>
    );
  }
  return (
    <span className="chip chip--warn" title="No API key found - this provider may fail">
      <Icon name="alert" size={10} />
      no key
    </span>
  );
}

function ProviderRow({
  provider,
  active,
  busy,
  onSelect,
  asButton,
}: {
  provider: ProviderSummary;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  asButton: boolean;
}) {
  const content = (
    <>
      <span className="provider__head">
        <span className="provider__label">
          {active ? <Icon name="check" size={13} /> : <span className="provider__dot" />}
          {provider.label}
        </span>
        {providerKeyBadge(provider)}
        {provider.supportsVision ? (
          <span className="chip chip--ok" title="This model can read images">
            <Icon name="image" size={10} />
            vision
          </span>
        ) : null}
      </span>
      <span className="provider__meta">
        <span className="provider__kind">{provider.kind}</span>
        <span className="provider__model">{provider.model}</span>
        {provider.baseUrl ? <span className="provider__url">{provider.baseUrl}</span> : null}
      </span>
      {provider.source ? <span className="provider__source">source: {provider.source}</span> : null}
    </>
  );

  if (asButton) {
    return (
      <button
        type="button"
        role="menuitem"
        className={`provider${active ? ' provider--active' : ''}`}
        onClick={onSelect}
        disabled={busy || active}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={`provider${active ? ' provider--active' : ''}`}>
      {content}
      {active ? (
        <span className="provider__current">
          <Icon name="check-circle" size={13} />
          active
        </span>
      ) : (
        <button
          type="button"
          className="button button--tiny button--ghost"
          onClick={onSelect}
          disabled={busy}
        >
          Switch
        </button>
      )}
    </div>
  );
}

const GROUP_ORDER = ['Local router', 'VyceAI', 'FreeInference', 'SilkRoute', 'Pollinations', 'Other'];

/** Which family a provider belongs to, so the menu groups related models. */
function providerGroup(provider: ProviderSummary): string {
  const url = provider.baseUrl ?? '';
  if (url.includes(':8705')) return 'Local router';
  if (url.includes('vyceai.com')) return 'VyceAI';
  if (url.includes('freeinference.org')) return 'FreeInference';
  if (url.includes(':8760')) return 'SilkRoute';
  if (url.includes('pollinations')) return 'Pollinations';
  return 'Other';
}

/**
 * Provider switcher.
 *
 * `compact` renders a dropdown button (used in the composer), `panel` renders
 * the full list (used in the settings modal and the command palette).
 */
export function ProviderPicker({
  providers,
  activeId,
  onSwitch,
  variant = 'compact',
  busy = false,
  label = 'Model provider',
}: ProviderPickerProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const active = providers.find((provider) => provider.id === activeId) ?? null;

  // Show models that can actually answer: a resolved key, a keyless
  // provider, or a local runtime. Unconfigured cloud providers are noise in
  // a side panel.
  const usable = useMemo(() => {
    const rank = (provider: ProviderSummary) => {
      const index = GROUP_ORDER.indexOf(providerGroup(provider));
      return index < 0 ? GROUP_ORDER.length : index;
    };
    return providers
      .filter(
        (provider) =>
          provider.hasKey ||
          provider.id === 'pollinations' ||
          provider.kind === 'ollama' ||
          provider.kind === 'lmstudio' ||
          provider.kind === 'llamacpp',
      )
      .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  }, [providers]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const index = usable.findIndex((provider) => provider.id === activeId);
    setActiveIndex(index >= 0 ? index : 0);
  }, [open, usable, activeId]);

  useEffect(() => {
    if (!open) return;
    const node = itemRefs.current[activeIndex];
    node?.focus();
  }, [open, activeIndex]);

  if (variant === 'panel') {
    return (
      <div className="provider-list" role="list" aria-label={label}>
        {usable.length === 0 ? <p className="provider-list__empty">No providers available.</p> : null}
        {usable.map((provider) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            active={provider.id === activeId}
            busy={busy}
            asButton={false}
            onSelect={() => onSwitch(provider.id)}
          />
        ))}
      </div>
    );
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (usable.length === 0 ? 0 : (index + 1) % usable.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) =>
        usable.length === 0 ? 0 : (index - 1 + usable.length) % usable.length,
      );
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(Math.max(0, usable.length - 1));
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  const choose = (provider: ProviderSummary) => {
    setOpen(false);
    if (provider.id !== activeId) onSwitch(provider.id);
  };

  return (
    <div
      className={`provider-picker${variant === 'pill' ? ' provider-picker--pill' : ''}`}
      ref={rootRef}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className={`provider-picker__trigger${variant === 'pill' ? ' provider-picker__trigger--pill' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}. Current: ${active?.label ?? 'none'}`}
        title={active ? `${active.label} · ${active.model}` : label}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="sparkle" size={13} />
        {variant === 'pill' ? (
          <span className="provider-picker__model provider-picker__model--pill">
            {active?.model ?? 'No model'}
          </span>
        ) : (
          <span className="provider-picker__label">{active?.label ?? 'No provider'}</span>
        )}
        <Icon name="chevron-down" size={13} />
      </button>

      {open ? (
        <div className="provider-picker__menu" role="menu" aria-label={label}>
          {usable.length === 0 ? (
            <p className="provider-list__empty">No providers available.</p>
          ) : null}
          {usable.map((provider, index) => (
            <button
              type="button"
              role="menuitem"
              key={provider.id}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              className={`provider provider--menu${provider.id === activeId ? ' provider--active' : ''}`}
              onClick={() => choose(provider)}
            >
              <span className="provider__head">
                <span className="provider__label">
                  {provider.id === activeId ? <Icon name="check" size={13} /> : <span className="provider__dot" />}
                  {provider.label}
                </span>
                {providerKeyBadge(provider)}
              </span>
              <span className="provider__meta">
                <span className="provider__kind">{provider.kind}</span>
                <span className="provider__model">{provider.model}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
