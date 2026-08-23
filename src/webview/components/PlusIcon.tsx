export function PlusIcon(props: { class?: string; size?: number }) {
  const size = () => props.size ?? 14;
  return (
    <svg
      class={props.class}
      width={size()}
      height={size()}
      viewBox="0 0 14 14"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M6 2h2v4h4v2H8v4H6V8H2V6h4z" />
    </svg>
  );
}
