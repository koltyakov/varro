import binocularSvg from 'iconoir/icons/binocular.svg?raw';
import cubeScanSolidSvg from 'iconoir/icons/cube-scan-solid.svg?raw';
import { describe, expect, it } from 'vitest';
import { getCatalogIcon } from './agent-icon-catalog';

describe('agent icon catalog', () => {
  it.each([
    ['binocular', binocularSvg],
    ['cube-scan-solid', cubeScanSolidSvg],
  ])('resolves %s to its SVG data URL', (name, svg) => {
    expect(getCatalogIcon(name)).toBe(`data:image/svg+xml,${encodeURIComponent(svg)}`);
  });

  it.each(['not-an-icon', '../../cube'])('rejects %s', (name) => {
    expect(getCatalogIcon(name)).toBeUndefined();
  });
});
