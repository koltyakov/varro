const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const EXTERNAL_LINK_PATHS = [
  'M3.33789 17C5.06694 19.989 8.29866 22 12.0001 22C15.7015 22 18.9332 19.989 20.6622 17',
  'M3.33789 7C5.06694 4.01099 8.29866 2 12.0001 2C15.7015 2 18.9332 4.01099 20.6622 7',
  'M13 21.9506C13 21.9506 14.4079 20.0966 15.2947 16.9999',
  'M13 2.04932C13 2.04932 14.4079 3.90328 15.2947 7',
  'M11 21.9506C11 21.9506 9.59215 20.0966 8.70532 16.9999',
  'M11 2.04932C11 2.04932 9.59215 3.90328 8.70532 7',
  'M9 10L10.5 15L12 10L13.5 15L15 10',
  'M1 10L2.5 15L4 10L5.5 15L7 10',
  'M17 10L18.5 15L20 10L21.5 15L23 10',
] as const;

export function createExternalLinkIconElement(): SVGSVGElement {
  const icon = document.createElementNS(SVG_NAMESPACE, 'svg');
  icon.setAttribute('class', 'external-link-icon');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('aria-hidden', 'true');

  for (const d of EXTERNAL_LINK_PATHS) {
    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    icon.append(path);
  }
  return icon;
}

export function ExternalLinkIcon() {
  return (
    <svg class="external-link-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {EXTERNAL_LINK_PATHS.map((d) => (
        <path
          d={d}
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      ))}
    </svg>
  );
}
