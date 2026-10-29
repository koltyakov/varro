import brainWarningSvg from 'iconoir/icons/brain-warning.svg?raw';
import clockSvg from 'iconoir/icons/clock.svg?raw';
import downloadSvg from 'iconoir/icons/download.svg?raw';
import folderSvg from 'iconoir/icons/folder.svg?raw';
import warningCircleSvg from 'iconoir/icons/warning-circle.svg?raw';
import warningTriangleSvg from 'iconoir/icons/warning-triangle.svg?raw';
import { describe, expect, it } from 'vitest';
import { statusIcons } from './status-icons';

describe('statusIcons', () => {
  it.each([
    ['brainWarning', brainWarningSvg],
    ['clock', clockSvg],
    ['download', downloadSvg],
    ['folder', folderSvg],
  ] as const)('keeps the %s Iconoir outline with a lighter stroke', (name, original) => {
    const source = statusIcons[name];
    expect(source).toMatch(/^data:image\/svg\+xml,/);
    const svg = decodeURIComponent(source.slice(source.indexOf(',') + 1));
    const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const originalDocument = new DOMParser().parseFromString(original, 'image/svg+xml');
    expect(document.querySelector('parsererror')).toBeNull();
    expect(document.documentElement.getAttribute('stroke-width')).toBe('1');
    expect(originalDocument.documentElement.getAttribute('stroke-width')).toBe('1.5');
    expect(document.documentElement.getAttribute('fill')).toBe('none');
    expect(document.documentElement.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(document.documentElement.innerHTML).toBe(originalDocument.documentElement.innerHTML);
  });

  it.each([
    ['warningCircle', warningCircleSvg],
    ['warningTriangle', warningTriangleSvg],
  ] as const)('keeps a visible filled exclamation dot in %s', (name, original) => {
    const source = statusIcons[name];
    const svg = decodeURIComponent(source.slice(source.indexOf(',') + 1));
    const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const originalDocument = new DOMParser().parseFromString(original, 'image/svg+xml');
    expect(document.querySelector('parsererror')).toBeNull();
    expect(document.documentElement.getAttribute('stroke-width')).toBe('1');
    expect(document.documentElement.getAttribute('fill')).toBe('none');
    expect(document.documentElement.getAttribute('viewBox')).toBe('0 0 24 24');
    const paths = (value: Document) =>
      [...value.querySelectorAll('path')].map((path) => path.getAttribute('d'));
    expect(paths(document)).toEqual(
      paths(originalDocument).filter((path) => path !== 'M12 17.01L12.01 16.9989')
    );
    expect(document.querySelectorAll('circle')).toHaveLength(1);
    const dot = document.querySelector('circle');
    expect(dot?.getAttribute('cx')).toBe('12');
    expect(dot?.getAttribute('cy')).toBe('17');
    expect(dot?.getAttribute('r')).toBe('1');
    expect(dot?.getAttribute('fill')).toBe('currentColor');
    expect(dot?.getAttribute('stroke')).toBe('none');
  });
});
