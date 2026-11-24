import React, { useEffect, useId, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { useArlo } from '../../contexts/ArloContext';
import { ENDED } from '../../lib/arloDid';
import Button from '../ui/Button';
import Input from '../ui/Input';

const MAX_QUESTION_CHARS = 500;
// How long "Waiting for approval…" stays without word of how it ended
// (the server lets an approval wait a minute)
const WAITING_MS = 70 * 1000;

/**
 * One input for a private question or request. The answer comes from the
 * server and is shown to the asker only, above the input. When what was asked
 * needs an owner's approval first, a line under the answer says so until the
 * server says how it ended (an `arlo.did` for that tool, in ArloContext
 * `actions`) or WAITING_MS passed.
 */
export default function AskArlo() {
  const { ask, asking, actions } = useArlo();
  const inputId = useId();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [error, setError] = useState(null);
  // null, or { tool, known }: `known` are the actions of that tool that had ended before
  const [waiting, setWaiting] = useState(null);

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
    setWaiting(result.action?.status === 'waiting_approval'
      ? {
        tool: result.action.tool,
        known: new Set(actions.filter((one) => one.tool === result.action.tool && ENDED.has(one.status)).map((one) => one.id)),
      }
      : null);
  };

  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setTimeout(() => setWaiting(null), WAITING_MS);
    return () => clearTimeout(timer);
  }, [waiting]);

  // An action of that tool ended since: the wait is over
  useEffect(() => {
    if (!waiting) return;
    const ended = actions.some((one) => one.tool === waiting.tool && ENDED.has(one.status) && !waiting.known.has(one.id));
    if (ended) setWaiting(null);
  }, [waiting, actions]);

  const clear = () => {
    setAnswer(null);
    setWaiting(null);
  };

  return (
    <div className="arlo-ask">
      {answer !== null && (
        <div className="arlo-ask-answer" aria-live="polite">
          <p className="arlo-ask-answer-text">{answer}</p>
          <div className="arlo-ask-answer-foot">
            <span className="arlo-muted">Only you see this.</span>
            <Button variant="link" size="sm" onClick={clear}>Clear</Button>
          </div>
        </div>
      )}
      {waiting && <p className="arlo-muted" role="status">Waiting for approval…</p>}
      {error && <p className="arlo-error" role="alert">{error}</p>}
      <form className="arlo-ask-form" onSubmit={submit}>
        <label className="arlo-sr-only" htmlFor={inputId}>Ask Arlo</label>
        <Input
          id={inputId}
          type="text"
          placeholder="Ask Arlo, or say “Arlo, …”"
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
