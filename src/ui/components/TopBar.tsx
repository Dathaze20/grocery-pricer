import type { Screen } from '../App';

export function TopBar(props: {
  title: string;
  go: (screen: Screen) => void;
  back?: Screen | null;
  action?: { label: string; onClick: () => void } | null;
}): JSX.Element {
  const back = props.back ?? null;
  return (
    <header className="topbar">
      {back !== null && (
        <button type="button" onClick={() => props.go(back)} aria-label="Back">
          ‹ Back
        </button>
      )}
      <h1>{props.title}</h1>
      {props.action != null && (
        <button type="button" onClick={props.action.onClick}>
          {props.action.label}
        </button>
      )}
    </header>
  );
}
