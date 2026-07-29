export function WarningIcon(props: {
  class?: string;
  width?: number | string;
  height?: number | string;
}) {
  return (
    <svg
      class={props.class}
      viewBox="0 0 16 16"
      width={props.width}
      height={props.height}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M7.13 2.5a1 1 0 011.74 0l6.49 11.25a1 1 0 01-.87 1.5H1.51a1 1 0 01-.87-1.5L7.13 2.5zM8 5.75a.75.75 0 00-.75.75v4a.75.75 0 001.5 0v-4A.75.75 0 008 5.75zM8 13.5a1 1 0 100-2 1 1 0 000 2z" />
    </svg>
  );
}
