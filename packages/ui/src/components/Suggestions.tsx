import { Icon } from './Icon';

export interface SuggestionsProps {
  questions: string[];
  /** Starts a new turn with the chosen question. */
  onAsk: (question: string) => void;
}

/**
 * The "Related" block under an answer.
 *
 * Research is a conversation, not a query. Offering the next question turns a
 * dead end into a thread, which is what makes this feel like a research
 * assistant rather than a search box.
 */
export function Suggestions({ questions, onAsk }: SuggestionsProps) {
  if (questions.length === 0) return null;

  return (
    <section className="suggestions" aria-label="Related questions">
      <div className="suggestions__label">Related</div>
      <div className="suggestions__list">
        {questions.map((question) => (
          <button
            type="button"
            className="suggestion"
            key={question}
            onClick={() => onAsk(question)}
          >
            <Icon name="search" size={13} className="suggestion__icon" />
            <span className="suggestion__text">{question}</span>
            <Icon name="chevron-right" size={13} className="suggestion__chevron" />
          </button>
        ))}
      </div>
    </section>
  );
}
