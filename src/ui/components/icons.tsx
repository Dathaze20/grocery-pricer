/**
 * Small inline icons.
 *
 * Inline SVG rather than emoji: emoji are drawn by whichever font the phone happens to use, so
 * they arrive at a different size, weight and colour than everything around them - which is most
 * of what makes an interface look thrown together. These inherit the text colour and size.
 */

type IconProps = { readonly size?: number };

function Svg(props: { children: React.ReactNode; size?: number }): JSX.Element {
  return (
    <svg
      width={props.size ?? 22}
      height={props.size ?? 22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {props.children}
    </svg>
  );
}

export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <Svg size={props.size}>
      <polyline points="20 6 9 17 4 12" />
    </Svg>
  );
}

export function CameraIcon(props: IconProps): JSX.Element {
  return (
    <Svg size={props.size}>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </Svg>
  );
}

export function GalleryIcon(props: IconProps): JSX.Element {
  return (
    <Svg size={props.size}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </Svg>
  );
}

export function SendIcon(props: IconProps): JSX.Element {
  return (
    <Svg size={props.size}>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </Svg>
  );
}
