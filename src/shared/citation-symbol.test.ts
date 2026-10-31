import { describe, expect, it } from 'vitest';
import { parseCitationSymbol } from './citation-symbol';

describe('parseCitationSymbol', () => {
  it.each([
    ['loss_weights()', 'loss_weights'],
    ['soft_updates()', 'soft_updates'],
    ['stack_on_channel()', 'stack_on_channel'],
    ['CustomMultiTaskRLBenchEnv', 'CustomMultiTaskRLBenchEnv'],
  ])('recognizes %s', (text, name) => expect(parseCitationSymbol(text)).toBe(name));

  it.each([
    'transporter / franka / clip',
    'clip',
    'Error',
    'src/app.ts',
    'seedX/config.yaml',
    'logs/<task_name>',
    '$PROJECT_DIR/train.py',
    'obj.method()',
    'f(args)',
    'foo ()',
    'x'.repeat(129),
  ])('does not infer a symbol from %s', (text) => expect(parseCitationSymbol(text)).toBeNull());
});
