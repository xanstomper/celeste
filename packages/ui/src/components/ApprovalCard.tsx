import { useState } from 'react';
import type { ApprovalRequest } from '@celeste/protocol';

import { humanizeToolName } from '../lib/format';
import { Icon } from './Icon';
import { JsonView } from './JsonView';

export interface ApprovalCardProps {
  request: ApprovalRequest;
  decision: 'approve' | 'deny' | undefined;
  onRespond: (requestId: string, decision: 'approve' | 'deny') => void;
  busy?: boolean;
}

interface FlatField {
  path: string;
  value: string;
}

function flatten(value: unknown, prefix = ''): FlatField[] {
  if (value === null) return [{ path: prefix || 'value', value: 'null' }];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => flatten(entry, prefix ? `${prefix}[${index}]` : `[${index}]`));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [{ path: prefix || 'value', value: '{}' }];
    return entries.flatMap(([key, entry]) =>
      flatten(entry, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [{ path: prefix || 'value', value: String(value) }];
}

const RISK_COPY: Record<ApprovalRequest['risk'], string> = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
};

/**
 * The human-in-the-loop card.
 *
 * When the agent wants to perform a risky action it stops and asks. The card
 * spells out exactly what will happen and which arguments will be used, so
 * the operator can approve or deny with confidence.
 */
export function ApprovalCard({ request, decision, onRespond, busy }: ApprovalCardProps) {
  const [showRaw, setShowRaw] = useState(false);
  const fields = flatten(request.arguments);
  const decided = decision !== undefined;

  return (
    <section
      className={`approval approval--${request.risk}${decided ? ' approval--decided' : ''}`}
      aria-label="Approval required"
    >
      <header className="approval__head">
        <span className="approval__badge">
          <Icon name="shield" size={14} />
          Approval required
        </span>
        <span className={`chip chip--risk chip--risk-${request.risk}`}>{RISK_COPY[request.risk]}</span>
      </header>

      <h3 className="approval__tool">
        <Icon name="tool" size={14} />
        {humanizeToolName(request.toolName)}
      </h3>

      <p className="approval__reason">{request.reason}</p>

      <div className="approval__args">
        <h4 className="approval__label">Arguments that will be used</h4>
        <dl className="approval__fields">
          {fields.map((field) => (
            <div className="approval__field" key={field.path}>
              <dt className="approval__field-key">{field.path}</dt>
              <dd className="approval__field-value">{field.value}</dd>
            </div>
          ))}
        </dl>
        <button
          type="button"
          className="link-button"
          aria-expanded={showRaw}
          onClick={() => setShowRaw((value) => !value)}
        >
          <Icon name={showRaw ? 'chevron-down' : 'chevron-right'} size={12} />
          {showRaw ? 'Hide' : 'Show'} raw JSON
        </button>
        {showRaw ? <JsonView value={request.arguments} maxHeight={220} /> : null}
      </div>

      {decided ? (
        <p className={`approval__result approval__result--${decision}`}>
          <Icon name={decision === 'approve' ? 'check-circle' : 'x-circle'} size={14} />
          {decision === 'approve' ? 'Approved by you' : 'Denied by you'}
        </p>
      ) : (
        <footer className="approval__actions">
          <button
            type="button"
            className="button button--primary"
            onClick={() => onRespond(request.id, 'approve')}
            disabled={busy}
          >
            <Icon name="check" size={14} />
            Approve
          </button>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => onRespond(request.id, 'deny')}
            disabled={busy}
          >
            <Icon name="x" size={14} />
            Deny
          </button>
          <span className="approval__hint">
            <Icon name="lock" size={12} />
            Nothing runs until you decide
          </span>
        </footer>
      )}
    </section>
  );
}
