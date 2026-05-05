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
      <path d="M1.75 3h3.1l1.15 1.5h8c.55 0 1 .45 1 1v5.75c0 .97-.78 1.75-1.75 1.75H1.75C.78 13 0 12.22 0 11.25V4.75C0 3.78.78 3 1.75 3zm0 1A.75.75 0 001 4.75v6.5c0 .41.34.75.75.75h12.5c.41 0 .75-.34.75-.75V5.5h-8.5L5.35 4H1.75z" />
    </svg>
  );
}
