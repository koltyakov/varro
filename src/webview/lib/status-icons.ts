import brainWarningSvg from 'iconoir/icons/brain-warning.svg?raw';
import clockSvg from 'iconoir/icons/clock.svg?raw';
import downloadSvg from 'iconoir/icons/download.svg?raw';
import folderSvg from 'iconoir/icons/folder.svg?raw';
import warningCircleSvg from 'iconoir/icons/warning-circle.svg?raw';
import warningTriangleSvg from 'iconoir/icons/warning-triangle.svg?raw';

function thinOutline(svg: string): string {
  // SVG masks cannot change stroke weight through CSS. Keep the lighter stroke
  // in the source, without changing Iconoir's standard weight for small controls.
  const thinSvg = svg.replace(/stroke-width="[^"]*"/g, 'stroke-width="1"');
  return `data:image/svg+xml,${encodeURIComponent(thinSvg)}`;
}

function warningOutline(svg: string): string {
  // Iconoir's tiny round-capped segment becomes subpixel when the outline is thinned.
  // Keep an explicit filled dot visible at the 20px status-icon size.
  return thinOutline(
    svg.replace(
      /<path d="M12 17\.01L12\.01 16\.9989"[^>]*\/>/,
      '<circle cx="12" cy="17" r="1" fill="currentColor" stroke="none" />'
    )
  );
}

export const statusIcons = {
  brainWarning: thinOutline(brainWarningSvg),
  clock: thinOutline(clockSvg),
  download: thinOutline(downloadSvg),
  folder: thinOutline(folderSvg),
  warningCircle: warningOutline(warningCircleSvg),
  warningTriangle: warningOutline(warningTriangleSvg),
};
