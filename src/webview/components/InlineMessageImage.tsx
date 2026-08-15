import { Show, createEffect, createSignal } from 'solid-js';

export type InlineImagePresentation = 'contain' | 'cover' | 'ambient';

const MIN_COVER_VISIBLE_FRACTION = 0.72;

export function getInlineImagePresentation(
  naturalWidth: number,
  naturalHeight: number,
  frameWidth: number,
  frameHeight: number
): InlineImagePresentation {
  if (naturalWidth <= 0 || naturalHeight <= 0) return 'contain';

  const imageRatio = naturalWidth / naturalHeight;
  if (imageRatio < 1) return 'ambient';
  if (frameWidth <= 0 || frameHeight <= 0) return 'contain';

  const frameRatio = frameWidth / frameHeight;
  const coverScale = Math.max(frameWidth / naturalWidth, frameHeight / naturalHeight);
  const visibleFraction = Math.min(imageRatio / frameRatio, frameRatio / imageRatio);

  if (visibleFraction < MIN_COVER_VISIBLE_FRACTION) return 'ambient';
  return coverScale <= 1 ? 'cover' : 'contain';
}

export function InlineMessageImage(props: { src: string; alt: string }) {
  const [presentation, setPresentation] = createSignal<InlineImagePresentation>('contain');
  let currentSrc = props.src;

  createEffect(() => {
    const nextSrc = props.src;
    if (nextSrc === currentSrc) return;
    currentSrc = nextSrc;
    setPresentation('contain');
  });

  const handleLoad = (event: Event & { currentTarget: HTMLImageElement }) => {
    const image = event.currentTarget;
    const frame = image.parentElement?.getBoundingClientRect();
    setPresentation(
      getInlineImagePresentation(
        image.naturalWidth,
        image.naturalHeight,
        frame?.width ?? 0,
        frame?.height ?? 0
      )
    );
  };

  return (
    <>
      <Show when={presentation() === 'ambient'}>
        <img src={props.src} alt="" aria-hidden="true" class="chat-image-ambient" />
      </Show>
      <img
        src={props.src}
        alt={props.alt}
        class={`chat-image-img chat-image-img-${presentation()}`}
        onLoad={handleLoad}
      />
    </>
  );
}
