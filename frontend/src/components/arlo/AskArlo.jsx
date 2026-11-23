import React, { useId, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { useArlo } from '../../contexts/ArloContext';
import Button from '../ui/Button';
import Input from '../ui/Input';

const MAX_QUESTION_CHARS = 500;

/**
 * One input for a private question. The answer comes from the meeting's
 * transcript on the server and is shown to the asker only, above the input.
 */
export default function AskArlo() {
  const { ask, asking } = useArlo();
  const inputId = useId();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    if (asking) return;
    setError(null);
    const result = await ask(question);
    if (result.error) {
      setError(result.error);
      return;
    }
    setAnswer(result.answer);
    setQuestion('');
  };

  return (
    <div className="arlo-ask">
      {answer !== null && (
        <div className="arlo-ask-answer" aria-live="polite">
          <p className="arlo-ask-answer-text">{answer}</p>
          <div className="arlo-ask-answer-foot">
            <span className="arlo-muted">Only you see this.</span>
            <Button variant="link" size="sm" onClick={() => setAnswer(null)}>Clear</Button>
          </div>
        </div>
      )}
      {error && <p className="arlo-error" role="alert">{error}</p>}
      <form className="arlo-ask-form" onSubmit={submit}>
        <label className="arlo-sr-only" htmlFor={inputId}>Ask Arlo</label>
        <Input
          id={inputId}
          type="text"
          placeholder="Ask Arlo"
          autoComplete="off"
          maxLength={MAX_QUESTION_CHARS}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          disabled={asking}
        />
        <Button type="submit" size="icon" aria-label="Ask" disabled={asking}>
          <ArrowUp size={16} aria-hidden="true" />
        </Button>
      </form>
    </div>
  );
}
