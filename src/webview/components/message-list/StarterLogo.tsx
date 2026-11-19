import { createSignal, onSettled } from 'solid-js';
import chatLogoUri from '../../../../assets/icon.png?inline';
import { toCssUrl } from '../UiIcon';
import { TileWaves } from './TileWaves';

const WAVE_SIZE = 64;

export function StarterLogo(props: { contained?: boolean } = {}) {
  // oxlint-disable-next-line no-unassigned-vars
  let logoRef: HTMLImageElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let canvasRef: HTMLCanvasElement | undefined;
  let waves: TileWaves | undefined;
  const [position, setPosition] = createSignal<{ top: string; left: string }>();

  onSettled(() => {
    const cleanups: Array<() => void> = [];

    if (props.contained && canvasRef) {
      waves = new TileWaves(canvasRef);
      cleanups.push(() => waves?.dispose());
      return () => {
        for (const cleanup of cleanups.toReversed()) cleanup();
      };
    }
    const logo = logoRef;
    const area = logo?.closest<HTMLElement>('.interactive-list-shell');
    const hints = logo
      ?.closest('.chat-empty-state')
      ?.querySelector<HTMLElement>('.chat-empty-hints');
    if (!logo || !area || !hints || !canvasRef)
      return () => {
        for (const cleanup of cleanups.toReversed()) cleanup();
      };
    waves = new TileWaves(canvasRef);

    const updateOverlap = () => {
      const logoBox = logo.getBoundingClientRect();
      const hintsBox = hints.getBoundingClientRect();
      const overlaps =
        logoBox.left < hintsBox.right &&
        logoBox.right > hintsBox.left &&
        logoBox.top < hintsBox.bottom &&
        logoBox.bottom > hintsBox.top;
      hints.classList.toggle('is-logo-overlapping', overlaps);
    };

    const updatePosition = () => {
      waves?.stop();
      const box = area.getBoundingClientRect();
      setPosition({
        top: `${box.top + box.height / 2}px`,
        left: `${box.left + box.width / 2}px`,
      });
      updateOverlap();
    };

    // Capture the initial message area, not its later composer-driven resizing.
    updatePosition();
    const observer = new ResizeObserver(updateOverlap);
    observer.observe(area);
    observer.observe(logo);
    observer.observe(hints);
    window.addEventListener('resize', updatePosition);
    cleanups.push(() => {
      waves?.dispose();
      observer.disconnect();
      window.removeEventListener('resize', updatePosition);
      hints.classList.remove('is-logo-overlapping');
    });

    return () => {
      for (const cleanup of cleanups.toReversed()) cleanup();
    };
  });

  return (
    <span
      class={['chat-empty-logo-shell', { 'is-contained': props.contained }]}
      style={position()}
      aria-hidden="true"
    >
      <img
        ref={logoRef}
        class="chat-empty-logo"
        src={chatLogoUri}
        decoding="sync"
        width="256"
        height="256"
        alt=""
        aria-hidden="true"
        draggable="false"
        onPointerEnter={(event) => waves?.enter(event.clientX, event.clientY)}
        onPointerMove={(event) => waves?.move(event.clientX, event.clientY)}
        onPointerLeave={() => waves?.leave()}
        onPointerCancel={() => waves?.leave()}
      />
      <canvas
        ref={canvasRef}
        class="chat-empty-logo-waves"
        style={{ 'mask-image': toCssUrl(chatLogoUri) }}
        width={WAVE_SIZE}
        height={WAVE_SIZE}
        aria-hidden="true"
      />
    </span>
  );
}
