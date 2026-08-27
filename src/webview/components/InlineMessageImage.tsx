import { Show, createEffect, createSignal, onMount } from 'solid-js';
import { isFunction } from '../lib/runtime-values';

export type InlineImagePresentation = 'contain' | 'cover' | 'ambient';

const MIN_COVER_VISIBLE_FRACTION = 0.72;
const MAX_CACHED_IMAGE_DIMENSIONS = 16;
const cachedImageDimensions = new Map<string, { width: number; height: number }>();

function getImageDimensionCacheKey(src: string) {
  if (src.length <= 256) return src;

  let sample = '';
  for (let index = 0; index < 32; index += 1) {
    sample += src[Math.floor((index * (src.length - 1)) / 31)];
  }
  return `${src.length}:${src.slice(0, 48)}:${sample}:${src.slice(-48)}`;
}

function rememberImageDimensions(src: string, width: number, height: number) {
  if (width <= 0 || height <= 0) return;
  const key = getImageDimensionCacheKey(src);
  cachedImageDimensions.delete(key);
  cachedImageDimensions.set(key, { width, height });
  while (cachedImageDimensions.size > MAX_CACHED_IMAGE_DIMENSIONS) {
    const oldestKey = cachedImageDimensions.keys().next().value;
    if (oldestKey === undefined) break;
    cachedImageDimensions.delete(oldestKey);
  }
}

function getCachedImageDimensions(src: string) {
  return cachedImageDimensions.get(getImageDimensionCacheKey(src));
}

export async function preloadInlineImageDimensions(src: string) {
  if (getCachedImageDimensions(src) || globalThis.Image === undefined) return;

  const image = new globalThis.Image();
  image.src = src;
  if (!isFunction(image.decode)) return;
  try {
    await image.decode();
    rememberImageDimensions(src, image.naturalWidth, image.naturalHeight);
  } catch {
    // The normal message image load path remains the fallback for unsupported formats.
  }
}

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

export function InlineMessageImage(props: { src: string; alt: string; allowCover?: boolean }) {
  const [presentation, setPresentation] = createSignal<InlineImagePresentation>('contain');
  let currentSrc = props.src;
  let imageRef: HTMLImageElement | undefined;

  const updatePresentationFromDimensions = (
    image: HTMLImageElement,
    width: number,
    height: number
  ) => {
    const frame = image.parentElement?.getBoundingClientRect();
    const nextPresentation = getInlineImagePresentation(
      width,
      height,
      frame?.width ?? 0,
      frame?.height ?? 0
    );
    setPresentation(
      props.allowCover === false && nextPresentation === 'cover' ? 'ambient' : nextPresentation
    );
  };

  const updatePresentation = (image: HTMLImageElement) => {
    if (image.getAttribute('src') !== currentSrc) return;
    rememberImageDimensions(currentSrc, image.naturalWidth, image.naturalHeight);
    updatePresentationFromDimensions(image, image.naturalWidth, image.naturalHeight);
  };

  createEffect(() => {
    const nextSrc = props.src;
    if (nextSrc === currentSrc) return;
    currentSrc = nextSrc;
    setPresentation('contain');
    queueMicrotask(() => {
      if (currentSrc === nextSrc && imageRef?.getAttribute('src') === nextSrc && imageRef) {
        const cachedDimensions = getCachedImageDimensions(nextSrc);
        if (cachedDimensions) {
          updatePresentationFromDimensions(
            imageRef,
            cachedDimensions.width,
            cachedDimensions.height
          );
        } else if (imageRef.complete && imageRef.naturalWidth > 0) {
          updatePresentation(imageRef);
        }
      }
    });
  });

  onMount(() => {
    if (!imageRef) return;
    const cachedDimensions = getCachedImageDimensions(currentSrc);
    if (cachedDimensions) {
      updatePresentationFromDimensions(imageRef, cachedDimensions.width, cachedDimensions.height);
    } else if (imageRef.complete && imageRef.naturalWidth > 0) {
      updatePresentation(imageRef);
    }
  });

  const handleLoad = (event: Event & { currentTarget: HTMLImageElement }) => {
    updatePresentation(event.currentTarget);
  };

  return (
    <>
      <Show when={presentation() === 'ambient'}>
        <img src={props.src} alt="" aria-hidden="true" class="chat-image-ambient" />
      </Show>
      <img
        ref={(element) => {
          imageRef = element;
        }}
        src={props.src}
        alt={props.alt}
        class={`chat-image-img chat-image-img-${presentation()}`}
        onLoad={handleLoad}
      />
    </>
  );
}
