import type { Screen } from '../App';
import { ChevronLeftIcon } from './icons';

/**
 * The bar at the top of every screen.
 *
 * The back control keeps its word as well as its arrow: an unlabelled chevron is a guess, and
 * this is used at a counter with one hand and a receipt in the other.
 */
export function TopBar(props: {
  title: string;
  go: (screen: Screen) => void;
  back?: Screen | null;
  wordmark?: boolean;
  action?: { label: string; icon?: JSX.Element; onClick: () => void } | null;
}): JSX.Element {
  const back = props.back ?? null;
  return (
    <header className="topbar">
      {back !== null && (
        <button type="button" onClick={() => props.go(back)}>
          <ChevronLeftIcon size={20} />
          Back
        </button>
      )}
      <h1 className={props.wordmark === true ? 'wordmark' : undefined}>{props.title}</h1>
      {props.action != null && (
        <button
          type="button"
          className={props.action.icon !== undefined ? 'icon-btn' : undefined}
          aria-label={props.action.label}
          title={props.action.label}
          onClick={props.action.onClick}
        >
          {props.action.icon ?? props.action.label}
        </button>
      )}
    </header>
  );
}
