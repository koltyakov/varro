export function formatVariantLabel(variant: string) {
  return variant
    .split(/[-_]/g)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}

export function formatVariantInitial(variant: string) {
  const label = formatVariantLabel(variant).trim();
  return label ? label[0] : '';
}

export function formatAgentLabel(agent: string | null | undefined) {
  if (!agent) return '';
  return agent[0].toUpperCase() + agent.slice(1);
}

export function formatAgentInitial(agent: string | null | undefined) {
  const label = formatAgentLabel(agent).trim();
  return label ? label[0] : '';
}

export function formatContextLimit(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}
