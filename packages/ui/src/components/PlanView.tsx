import { useEffect, useState } from 'react';
import type { PlanStep } from '@celeste/protocol';
import { Icon } from './Icon';

export interface PlanViewProps {
  steps: PlanStep[];
}

function stepIcon(step: PlanStep) {
  switch (step.status) {
    case 'done':
      return <Icon name="check" size={12} />;
    case 'active':
      return <Icon name="spinner" size={12} />;
    case 'failed':
      return <Icon name="x" size={12} />;
    case 'skipped':
      return <Icon name="chevron-right" size={12} />;
    default:
      return <span className="plan-step__dot" />;
  }
}

export function PlanView({ steps }: PlanViewProps) {
  const done = steps.filter((step) => step.status === 'done').length;
  const failed = steps.filter((step) => step.status === 'failed').length;
  const percent = steps.length > 0 ? Math.round((done / steps.length) * 100) : 0;
  const complete =
    steps.length > 0 && steps.every((step) => step.status === 'done' || step.status === 'skipped');
  const [open, setOpen] = useState(!complete);

  useEffect(() => {
    if (complete) setOpen(false);
  }, [complete]);

  if (steps.length === 0) return null;

  return (
    <section className={`plan${open ? ' plan--open' : ''}`} aria-label="Task plan">
      <button
        type="button"
        className="plan__head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <div className="plan__title-group">
          <span className="plan__icon-badge">
            <Icon name="list" size={13} />
          </span>
          <span className="plan__title">Research & Action Plan</span>
        </div>

        <div className="plan__meta-group">
          <span className="plan__progress-pill">
            {done}/{steps.length} steps · {percent}%
            {failed > 0 ? ` · ${failed} failed` : ''}
          </span>
          <span className="plan__chevron">
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
          </span>
        </div>
      </button>

      {open ? (
        <>
          <div
            className="plan__bar"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Plan progress"
          >
            <span className="plan__bar-fill" style={{ width: `${percent}%` }} />
          </div>

          <ol className="plan__steps">
            {steps.map((step, idx) => (
              <li key={step.id} className={`plan-step plan-step--${step.status}`}>
                <span className="plan-step__num">0{idx + 1}</span>
                <span className="plan-step__icon">{stepIcon(step)}</span>
                <div className="plan-step__content">
                  <span className="plan-step__text">{step.description}</span>
                  {step.notes ? <span className="plan-step__notes">{step.notes}</span> : null}
                </div>
                {step.status === 'active' ? (
                  <span className="plan-step__live-tag">In progress</span>
                ) : null}
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </section>
  );
}
