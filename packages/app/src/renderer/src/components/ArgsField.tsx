import { AGENT_PROGRAM } from '@orquestra/shared/args';

export function ArgsField(props: { agent: string; value: string; onChange(value: string): void; testId: string; disabled?: boolean }) {
  const program = AGENT_PROGRAM[props.agent as keyof typeof AGENT_PROGRAM] ?? props.agent;
  return (
    <div className="args-field">
      <span className="args-program">{program}</span>
      <input
        data-testid={props.testId}
        value={props.value}
        placeholder="argumentos extras"
        spellCheck={false}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  );
}
