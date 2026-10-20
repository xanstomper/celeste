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

/**
 * The live plan checklist.
 *
 * Renders every `PlanStep` with its state and a progress bar, so the user can
 * see where the agent is without reading the transcript.
 */
export function PlanView({ steps }: PlanViewProps) {
  if (steps.length === 0) return null;

  const done = steps.filter((step) => step.status === 'done').length;
  const failed = steps.filter((step) => step.status === 'failed').length;
  const percent = Math.round((done / steps.length) * 100);

  return (
    <section className="plan" aria-label="Task plan">
      <header className="plan__head">
        <span className="plan__title">
          <Icon name="list" size={13} />
          Plan
        </span>
        <span className="plan__progress-text">
          {done}/{steps.length} complete
          {failed > 0 ? ` · ${failed} failed` : ''}
        </span>
      </header>

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
        {steps.map((step) => (
          <li key={step.id} className={`plan-step plan-step--${step.status}`}>
            <span className="plan-step__icon">{stepIcon(step)}</span>
            <span className="plan-step__text">{step.description}</span>
            {step.notes ? <span className="plan-step__notes">{step.notes}</span> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
