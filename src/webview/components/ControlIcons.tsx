export function NavArrowLeftControlIcon(props: { class?: string }) {
  return (
    <svg
      class={props.class}
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="m12 6-4 4 4 4" />
    </svg>
  );
}

export function RefreshIcon(props: { class?: string }) {
  return (
    <svg
      class={props.class}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21.888 13.5A10 10 0 1 1 21.168 8" />
      <path d="M17 8h4.4a.6.6 0 0 0 .6-.6V3" />
    </svg>
  );
}
