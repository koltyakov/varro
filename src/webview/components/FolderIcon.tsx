export function FolderIcon(props: {
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
      <path d="M1.75 3h3.1c.31 0 .6.14.79.38l.86 1.12h7.75c.41 0 .75.34.75.75V6H1V3.75C1 3.34 1.34 3 1.75 3zM1 7h14v4.25c0 .97-.78 1.75-1.75 1.75H2.75A1.75 1.75 0 011 11.25V7z" />
    </svg>
  );
}
