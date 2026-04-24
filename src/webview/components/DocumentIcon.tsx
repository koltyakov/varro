export function DocumentIcon(props: {
  class?: string;
  width?: number | string;
  height?: number | string;
}) {
  return (
    <svg
      class={props.class}
      viewBox="0 0 32 32"
      width={props.width}
      height={props.height}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M13 4 6 11v17h20V4H13zm-1 3.828V10H9.828L12 7.828zM24 26H8V12h6V6h10v20z" />
    </svg>
  );
}
