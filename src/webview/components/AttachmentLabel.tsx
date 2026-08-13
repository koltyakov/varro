export function AttachmentLabel(props: { label: string; preserveExtension?: boolean }) {
  const extensionIndex = () => {
    if (!props.preserveExtension) return -1;
    const index = props.label.lastIndexOf('.');
    return index > 0 && index < props.label.length - 1 ? index : -1;
  };

  return (
    <span class={`chip-label${extensionIndex() >= 0 ? ' chip-label-with-extension' : ''}`}>
      {extensionIndex() >= 0 ? (
        <>
          <span class="chip-label-stem">{props.label.slice(0, extensionIndex())}</span>
          <span class="chip-label-extension">{props.label.slice(extensionIndex())}</span>
        </>
      ) : (
        props.label
      )}
    </span>
  );
}
