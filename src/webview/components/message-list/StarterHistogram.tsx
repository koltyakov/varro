import { onSettled } from 'solid-js';
import { getTileWaveProfile, TILE_WAVE_SPACING, TileWaves } from './TileWaves';

const HEIGHT = 112;
const BAR_WIDTH = TILE_WAVE_SPACING * 2;
const BAR_SPACING = BAR_WIDTH + 1;
const SETTLE_DURATION_MS = 2000;
const MIN_WAVE_INTERVAL_MS = 40;
const INTERACTION_REACH = 96;
const MAX_WAVES = 4;
const MAX_HIGHLIGHT_WAVES = 24;
const MIN_HIGHLIGHT_INTERVAL_MS = 180;

type WaveDirection = { x: number; y: number };

type HistogramWave = {
  startedAt: number;
  heightOffsets: number[];
  highlightSpread: number;
  highlightAmplitude: number;
  highlightFadeStart: number;
  highlightTravel: number;
  highlightRadius: number;
  highlightDuration: number;
  highlightVelocity: number;
  duration: number;
  phase: number;
  seed: number;
  highlightDistances: Float32Array;
  highlightStrengths: Float32Array;
  fade: number;
  highlightFade: number;
};

function sectorStrength(dx: number, dy: number, direction: WaveDirection | undefined) {
  const radius = Math.hypot(dx, dy);
  const alignment = direction && radius > 0 ? (dx * direction.x + dy * direction.y) / radius : 1;
  // A 120-degree forward sector, fading gently toward either side.
  const sector = Math.max(0, Math.min(1, (alignment - 0.5) / 0.35));
  return sector * sector * (3 - 2 * sector);
}

function tileNoise(column: number, row: number, seed: number) {
  let value = Math.imul(column + seed, 374761393) ^ Math.imul(row + 1, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function randomHeight() {
  return 20 + Math.floor(Math.random() * 21) * 4;
}

export function StarterHistogram(props: { onClick: () => void }) {
  // oxlint-disable-next-line no-unassigned-vars
  let canvasRef: HTMLCanvasElement | undefined;
  let waves: TileWaves | undefined;
  let interact: ((event: PointerEvent, entering: boolean) => void) | undefined;
  let leave: (() => void) | undefined;
  let burst: ((event: MouseEvent) => void) | undefined;

  onSettled(() => {
    const cleanups: Array<() => void> = [];

    const canvas = canvasRef;
    if (!canvas)
      return () => {
        for (const cleanup of cleanups.toReversed()) cleanup();
      };
    const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    // Keep this chat's generated profile and texture unchanged by pointer input.
    const targetHeights: number[] = [];
    const currentHeights: number[] = [];
    const velocities: number[] = [];
    const barMotion: { phase: number; rate: number }[] = [];
    let measuredWidth = 0;
    let heightScale = 1;
    let tileColumnCount = 0;
    let tileRowCount = 0;
    let sampledAt = performance.now();
    const motionPackets: HistogramWave[] = [];
    const highlightPackets: HistogramWave[] = [];
    const profileSeed = Math.floor(Math.random() * 1_000_000);
    let lastPointer: { x: number; y: number } | undefined;
    let lastPointerAt = 0;
    let hovering = false;
    let hoverStartedAt = 0;
    let lastWaveAt = Number.NEGATIVE_INFINITY;
    let lastHighlightAt = Number.NEGATIVE_INFINITY;
    let origin = { left: 0, top: 0, scaleY: 1 };

    const sampleHeights = (now: number) => {
      if (sampledAt === now) return;
      const elapsed = Math.min(0.032, Math.max(0, (now - sampledAt) / 1000));
      sampledAt = now;
      for (let index = motionPackets.length - 1; index >= 0; index--) {
        const packet = motionPackets[index]!;
        const age = now - packet.startedAt;
        if (age >= packet.duration || motionQuery?.matches) {
          motionPackets.splice(index, 1);
          continue;
        }
        packet.fade = Math.max(0, 1 - age / packet.duration) ** 0.7;
      }
      for (let index = highlightPackets.length - 1; index >= 0; index--) {
        const packet = highlightPackets[index]!;
        const age = now - packet.startedAt;
        if (age >= packet.highlightDuration || motionQuery?.matches) {
          highlightPackets.splice(index, 1);
          continue;
        }
        // Like the logo's entry wave, keep the crest visible until its final fade.
        packet.highlightFade = Math.min(
          1,
          (1 - age / packet.highlightDuration) / (1 - packet.highlightFadeStart)
        );
        packet.highlightRadius = Math.min(packet.highlightTravel, age * packet.highlightVelocity);
      }
      for (let index = 0; index < targetHeights.length; index++) {
        const current = currentHeights[index]!;
        let target = targetHeights[index]!;
        if (hovering && lastPointer && !motionQuery?.matches) {
          const proximity = Math.max(
            0,
            1 - Math.abs(index * BAR_SPACING + BAR_WIDTH / 2 - lastPointer.x) / INTERACTION_REACH
          );
          if (proximity > 0) {
            const { phase, rate } = barMotion[index]!;
            const time = (now - hoverStartedAt) / 1000;
            const beat =
              Math.sin(time * rate + phase) * 0.65 + Math.sin(time * rate * 0.61 - phase) * 0.35;
            target += beat * 32 * proximity ** 2;
          }
        }
        for (const packet of motionPackets) {
          target += packet.heightOffsets[index]! * packet.fade;
        }
        if (motionQuery?.matches) {
          currentHeights[index] = target;
          velocities[index] = 0;
          continue;
        }
        const velocity =
          velocities[index]! + ((target - current) * 175 - velocities[index]! * 20) * elapsed;
        velocities[index] = velocity;
        currentHeights[index] = Math.max(8, Math.min(HEIGHT - 4, current + velocity * elapsed));
        if (Math.abs(currentHeights[index]! - target) < 0.01 && Math.abs(velocity) < 0.05) {
          currentHeights[index] = target;
          velocities[index] = 0;
        }
      }
    };

    const emit = (
      x: number,
      y: number,
      motion: WaveDirection | undefined,
      speed: number,
      now: number,
      highlightSpeed = speed
    ) => {
      if (motionQuery?.matches) return;
      const motionLength = motion ? Math.hypot(motion.x, motion.y) : 0;
      const direction =
        motion && motionLength > 0
          ? { x: motion.x / motionLength, y: motion.y / motionLength }
          : undefined;
      const profile = getTileWaveProfile(highlightSpeed, true);
      const highlightSpread = TILE_WAVE_SPACING * (6 + Math.random() * 10);
      const highlightVelocity = (0.12 + Math.random() * 0.08) * (0.25 + highlightSpeed * 0.75);
      const originY = y * heightScale;
      const cornerDistance = Math.hypot(
        Math.max(x, canvas.width - x),
        Math.max(originY, canvas.height - originY)
      );
      const highlightReach = 64 + cornerDistance * highlightSpeed ** 1.4 * 1.2;
      const highlightTravel = Math.min(cornerDistance * 1.18, highlightReach) + highlightSpread;
      const duration = 720 + Math.random() * 240;
      const highlightDuration = Math.max(
        profile.duration,
        highlightTravel / (highlightVelocity * profile.fadeStart)
      );
      // New cursor origins emit independently; long sweeps must not block them for seconds.
      const canHighlight =
        highlightPackets.length < MAX_HIGHLIGHT_WAVES &&
        now - lastHighlightAt >=
          Math.max(MIN_HIGHLIGHT_INTERVAL_MS, highlightDuration / MAX_HIGHLIGHT_WAVES);
      const seed = Math.floor(Math.random() * 1_000_000);
      const packet: HistogramWave = {
        startedAt: now,
        // Cache random local changes once. Heights never target the cursor's Y or heading.
        heightOffsets: targetHeights.map((_, index) => {
          const proximity = Math.max(
            0,
            1 - Math.abs(index * BAR_SPACING + BAR_WIDTH / 2 - x) / INTERACTION_REACH
          );
          return (tileNoise(index, 0, seed + 73) * 2 - 1) * (12 + speed * 32) * proximity ** 2;
        }),
        // Broad ripple bands vary in width independently of their travel speed.
        highlightSpread,
        highlightAmplitude: profile.amplitude * 0.8 * (0.6 + highlightSpeed * 0.4),
        highlightFadeStart: profile.fadeStart,
        highlightTravel,
        highlightRadius: 0,
        highlightDuration,
        highlightVelocity,
        duration,
        phase: Math.random() * Math.PI * 2,
        seed,
        highlightDistances: new Float32Array(canHighlight ? tileColumnCount * tileRowCount : 0),
        highlightStrengths: new Float32Array(canHighlight ? tileColumnCount * tileRowCount : 0),
        fade: 1,
        highlightFade: 1,
      };
      // Existing local changes settle independently when the cursor moves elsewhere.
      if (motionPackets.length < MAX_WAVES) motionPackets.push(packet);
      if (canHighlight) {
        // Cache the contour and soft sector edges once per wave, never per animation frame.
        const lobes = 3 + Math.floor(tileNoise(0, 0, packet.seed) * 4);
        let farthest = 0;
        for (let row = 0; row < tileRowCount; row++) {
          for (let column = 0; column < tileColumnCount; column++) {
            const tileX =
              Math.floor(column / 2) * BAR_SPACING + ((column % 2) + 0.5) * TILE_WAVE_SPACING;
            const tileY = (row + 0.5) * TILE_WAVE_SPACING;
            const dx = tileX - x;
            const dy = tileY - originY;
            const angle = Math.atan2(dy, dx);
            const radius = Math.hypot(dx, dy);
            const warp =
              1 +
              Math.sin(angle * lobes + packet.phase) * 0.1 +
              Math.sin(angle * (lobes + 4) - packet.phase * 1.3) * 0.05 +
              Math.sin(angle * (lobes + 8) + packet.phase * 1.7) * 0.025;
            const grain = tileNoise(column, row, packet.seed);
            const index = row * tileColumnCount + column;
            const distance = Math.max(0, radius * warp + (grain - 0.5) * highlightSpread * 0.2);
            packet.highlightDistances[index] = distance;
            const brightness = tileNoise(column, row, packet.seed + 37);
            const directionalStrength = sectorStrength(dx, dy, direction);
            // Keep the grain soft and stable, without isolated high-contrast sparks.
            packet.highlightStrengths[index] =
              (0.56 + brightness ** 1.6 * 0.3) * directionalStrength;
            if (directionalStrength > 0) farthest = Math.max(farthest, distance);
          }
        }
        packet.highlightTravel = Math.min(farthest, highlightReach) + highlightSpread;
        packet.highlightDuration = Math.max(
          profile.duration,
          packet.highlightTravel / (highlightVelocity * profile.fadeStart)
        );
        highlightPackets.push(packet);
        lastHighlightAt = now;
      }
      lastWaveAt = now;
    };

    const redrawInteraction = (now: number) => {
      if (motionQuery?.matches || document.hidden) return;
      let until = now + SETTLE_DURATION_MS;
      for (const packet of highlightPackets)
        until = Math.max(until, packet.startedAt + packet.highlightDuration);
      waves?.redraw(until);
    };

    interact = (event, entering) => {
      const now = performance.now();
      if (!hovering && !motionQuery?.matches) {
        hovering = true;
        hoverStartedAt = now;
      }
      if (entering) {
        const box = canvas.getBoundingClientRect();
        origin = { left: box.left, top: box.top, scaleY: HEIGHT / Math.max(1, box.height) };
      }
      const pointer = {
        x: event.clientX - origin.left,
        // Clamping here erases vertical movement near the top and bottom edges.
        y: (event.clientY - origin.top) * origin.scaleY,
      };
      const dx = pointer.x - (lastPointer?.x ?? pointer.x);
      const dy = pointer.y - (lastPointer?.y ?? pointer.y);
      if (!entering && Math.hypot(dx, dy) < 2) return;
      if (entering || now - lastWaveAt >= MIN_WAVE_INTERVAL_MS) {
        const distance = Math.hypot(dx, dy / origin.scaleY);
        const speed = entering
          ? 0.25
          : Math.min(1, distance / Math.max(8, now - lastPointerAt) / 1.2);
        const highlightSpeed = entering
          ? 0.1
          : Math.min(1, (distance / Math.max(8, now - lastPointerAt)) * 1.4);
        emit(
          pointer.x,
          pointer.y,
          entering ? undefined : { x: dx, y: dy * heightScale },
          speed,
          now,
          highlightSpeed
        );
      }
      lastPointer = pointer;
      lastPointerAt = now;
      // Coalesced canvas frames handle the spring and lighting, without DOM writes.
      redrawInteraction(now);
    };
    leave = () => {
      hovering = false;
      lastPointer = undefined;
      redrawInteraction(performance.now());
    };
    burst = (event) => {
      if (motionQuery?.matches) return;
      const now = performance.now();
      const box = canvas.getBoundingClientRect();
      const x = event.clientX - box.left;
      const scaleY = HEIGHT / Math.max(1, box.height);
      const y = Math.max(8, Math.min(HEIGHT - 4, (event.clientY - box.top) * scaleY));
      origin = { left: box.left, top: box.top, scaleY };
      lastPointer = { x, y };
      lastPointerAt = now;
      emit(x, y, undefined, 1, now);
      redrawInteraction(now);
    };

    const resize = () => {
      const box = canvas.parentElement!.getBoundingClientRect();
      const width = Math.ceil(box.width);
      const height = Math.max(1, Math.ceil(box.height));
      if (!width || !box.height || (measuredWidth === width && canvas.height === height && waves))
        return;
      measuredWidth = width;
      waves?.dispose();
      const count = Math.max(1, Math.ceil(width / BAR_SPACING));
      tileColumnCount = count * 2;
      tileRowCount = Math.ceil(height / TILE_WAVE_SPACING);
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      heightScale = height / HEIGHT;
      origin = { left: box.left, top: box.top, scaleY: HEIGHT / Math.max(1, box.height) };
      // Retain existing bars on resize; only generate newly exposed columns.
      while (targetHeights.length < count) {
        const index = targetHeights.length;
        const barHeight = randomHeight();
        targetHeights.push(barHeight);
        currentHeights.push(barHeight);
        velocities.push(0);
        barMotion.push({
          phase: tileNoise(index, 1, profileSeed) * Math.PI * 2,
          rate: 8 + tileNoise(index, 2, profileSeed) * 8,
        });
      }
      for (let index = 0; index < targetHeights.length; index++) {
        currentHeights[index] = targetHeights[index]!;
        velocities[index] = 0;
      }
      motionPackets.length = 0;
      highlightPackets.length = 0;
      lastHighlightAt = Number.NEGATIVE_INFINITY;
      lastPointer = undefined;
      hovering = false;
      sampledAt = performance.now();
      waves = new TileWaves(canvas, {
        baseOpacity: 0.22,
        baseColor: 'rgb(128 128 128)',
        isAnimating: () => hovering,
        columnPositions: Array.from(
          { length: count * 2 },
          (_, index) =>
            Math.floor(index / 2) * BAR_SPACING + ((index % 2) + 0.5) * TILE_WAVE_SPACING
        ),
        containsTile: (x, y, now) => {
          sampleHeights(now);
          const column = Math.floor(x / BAR_SPACING);
          const lane = Math.floor((x % BAR_SPACING) / TILE_WAVE_SPACING);
          const trimmedLane = tileNoise(column, 0, profileSeed) < 0.5 ? 0 : 1;
          const trim = lane === trimmedLane ? TILE_WAVE_SPACING : 0;
          // Narrow, flat-ended bars with a one-pixel separator and one trimmed corner tile.
          const barHeight = Math.max(4, currentHeights[column]! * heightScale - trim);
          return x % BAR_SPACING <= BAR_WIDTH - 1.75 && y <= barHeight - 1.75;
        },
        tileIntensity: (x, y) => {
          const column = Math.floor(x / BAR_SPACING);
          const lane = Math.floor((x % BAR_SPACING) / TILE_WAVE_SPACING);
          const row = Math.floor(y / TILE_WAVE_SPACING);
          const index = row * tileColumnCount + column * 2 + lane;
          let intensity = 0;
          for (const packet of highlightPackets) {
            const distance = packet.highlightDistances[index]! - packet.highlightRadius;
            const offset = distance / packet.highlightSpread;
            // A rounded crest with a gentle falloff on both the inner and outer edges.
            const crest = Math.max(0, 1 - offset * offset) ** 2;
            intensity = Math.max(
              intensity,
              crest *
                packet.highlightFade *
                packet.highlightAmplitude *
                packet.highlightStrengths[index]!
            );
          }
          return intensity;
        },
      });
      waves.redraw();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas.parentElement!);
    const pauseInteraction = () => {
      if (!document.hidden && !motionQuery?.matches) return;
      hovering = false;
      lastPointer = undefined;
      motionPackets.length = 0;
      highlightPackets.length = 0;
      for (let index = 0; index < targetHeights.length; index++) {
        currentHeights[index] = targetHeights[index]!;
        velocities[index] = 0;
      }
    };
    document.addEventListener('visibilitychange', pauseInteraction);
    motionQuery?.addEventListener('change', pauseInteraction);
    cleanups.push(() => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', pauseInteraction);
      motionQuery?.removeEventListener('change', pauseInteraction);
      waves?.dispose();
    });

    return () => {
      for (const cleanup of cleanups.toReversed()) cleanup();
    };
  });

  return (
    <div
      class="chat-empty-histogram"
      aria-hidden="true"
      onClick={(event) => {
        burst?.(event);
        props.onClick();
      }}
      onPointerEnter={(event) => interact?.(event, true)}
      onPointerMove={(event) => interact?.(event, false)}
      onPointerLeave={() => leave?.()}
      onPointerCancel={() => leave?.()}
    >
      <canvas ref={canvasRef} class="chat-empty-histogram-waves" width="0" height={HEIGHT} />
    </div>
  );
}
