import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ProviderSummary } from '@celeste/protocol';

import { Icon } from './Icon';

export interface ProviderPickerProps {
  providers: ProviderSummary[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  variant?: 'compact' | 'panel';
  busy?: boolean;
  label?: string;
}

function providerKeyBadge(provider: ProviderSummary) {
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
    const index = providers.findIndex((provider) => provider.id === activeId);
    setActiveIndex(index >= 0 ? index : 0);
  }, [open, providers, activeId]);

  useEffect(() => {
    if (!open) return;
    const node = itemRefs.current[activeIndex];
    node?.focus();
  }, [open, activeIndex]);

  if (variant === 'panel') {
    return (
      <div className="provider-list" role="list" aria-label={label}>
        {providers.length === 0 ? <p className="provider-list__empty">No providers available.</p> : null}
        {providers.map((provider) => (
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
      setActiveIndex((index) => (providers.length === 0 ? 0 : (index + 1) % providers.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) =>
        providers.length === 0 ? 0 : (index - 1 + providers.length) % providers.length,
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
      setActiveIndex(Math.max(0, providers.length - 1));
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
    <div className="provider-picker" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="provider-picker__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}. Current: ${active?.label ?? 'none'}`}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="sparkle" size={13} />
        <span className="provider-picker__label">{active?.label ?? 'No provider'}</span>
        <span className="provider-picker__model">{active?.model ?? ''}</span>
        <Icon name="chevron-down" size={13} />
      </button>

      {open ? (
        <div className="provider-picker__menu" role="menu" aria-label={label}>
          {providers.length === 0 ? (
            <p className="provider-list__empty">No providers available.</p>
          ) : null}
          {providers.map((provider, index) => (
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
