import type { Page } from '@playwright/test';

export function viewportPixelGaps(
  page: Page,
  frames: string[],
  bounds: { x: number; y: number; width: number; height: number }
) {
  return page.evaluate(
    async ({ frames: capturedFrames, bounds: viewportBounds }) => {
      const result: number[] = [];
      for (const frame of capturedFrames) {
        const image = new Image();
        image.src = `data:image/png;base64,${frame}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Pixel coverage context is missing');
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, image.width, image.height).data;
        let gap = 0;
        let maxGap = 0;
        // Exclude sticky chrome and the bottom fade, but inspect every physical scanline between them.
        for (
          let y = Math.ceil(viewportBounds.y + 150);
          y < viewportBounds.y + viewportBounds.height - 20;
          y += 1
        ) {
          let painted = 0;
          for (
            let x = Math.ceil(viewportBounds.x + 18);
            x < viewportBounds.x + viewportBounds.width - 24;
            x += 1
          ) {
            const offset = (y * image.width + x) * 4;
            if (pixels[offset]! > 100 && pixels[offset + 1]! > 100 && pixels[offset + 2]! > 100)
              painted += 1;
          }
          gap = painted >= 3 ? 0 : gap + 1;
          maxGap = Math.max(maxGap, gap);
        }
        result.push(maxGap);
      }
      return result;
    },
    { frames, bounds }
  );
}
