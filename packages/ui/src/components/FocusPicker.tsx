import type { SearchFocus } from '@celeste/protocol';

import { Icon } from './Icon';
import type { IconName } from './Icon';

interface FocusOption {
  id: SearchFocus;
  label: string;
  icon: IconName;
  hint: string;
}

/**
 * The three places research can look.
 *
 * Perplexity calls this "focus"; the answer is written the same way in every
 * mode, but Academic starts from arXiv papers and News starts from today's
 * headlines. Keeping the labels short matters — the panel is 400px wide.
 */
const OPTIONS: FocusOption[] = [
  { id: 'web', label: 'Web', icon: 'globe', hint: 'Search the open web' },
  { id: 'academic', label: 'Academic', icon: 'book', hint: 'Start from arXiv papers' },
  { id: 'news', label: 'News', icon: 'news', hint: "Start from today's headlines" },
];

export interface FocusPickerProps {
  value: SearchFocus;
  onChange: (focus: SearchFocus) => void;
  disabled?: boolean;
}

export function FocusPicker({ value, onChange, disabled = false }: FocusPickerProps) {
  return (
    <div className="focus" role="radiogroup" aria-label="Research focus">
      {OPTIONS.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            className={`focus__chip${active ? ' focus__chip--active' : ''}`}
            onClick={() => onChange(option.id)}
            disabled={disabled}
            title={option.hint}
          >
            <Icon name={option.icon} size={13} />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
