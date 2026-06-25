export function getSpinnerPhaseDelayStyle(durationMs: number): { 'animation-delay': string } {
  return { 'animation-delay': `${-(Date.now() % durationMs)}ms` };
}
