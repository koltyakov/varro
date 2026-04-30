import { describe, expect, it } from 'vitest';
import type { RalphConfig, RalphIteration } from '../../../shared/ralph';
import {
  buildAnchorMessage,
  buildIterationPrompt,
  buildRepairSubAgentPrompt,
  buildVerificationPrompt,
  getDefaultPromptTemplate,
  readPlanDocument,
} from './ralph-prompts';

function createConfig(overrides: Partial<RalphConfig> = {}): RalphConfig {
  return {
    managerSessionId: 'manager-1',
    planDocPath: 'RALPH.md',
    iterations: 10,
    promptTemplate:
      'iteration={{iteration}} total={{totalIterations}} path={{planPath}}\n{{previousSummary}}\n{{verificationCommands}}',
    permissionMode: 'full',
    model: null,
    agent: null,
    createdAt: 1714521600000,
    ...overrides,
  };
}

function createIteration(overrides: Partial<RalphIteration> = {}): RalphIteration {
  return {
    index: 1,
    childSessionId: 'child-1',
    status: 'failed',
    startedAt: 100,
    endedAt: 200,
    filesChanged: ['src/a.ts'],
    verification: {
      lint: 'pass',
      typecheck: 'fail',
      test: 'pass',
    },
    note: 'Updated prompt builder coverage.',
    ...overrides,
  };
}

describe('ralph prompt helpers', () => {
  it('builds an iteration prompt with substituted variables and previous summary', async () => {
    const value = await buildIterationPrompt({
      config: createConfig(),
      iterationIndex: 2,
      previousIteration: createIteration(),
      readFile: async () => '# Plan\n- [ ] smallest chunk',
    });

    expect(value).toContain('iteration=2 total=10 path=RALPH.md');
    expect(value).toContain(
      'Previous iteration #1 status: failed (lint: pass, typecheck: fail, test: pass).'
    );
    expect(value).toContain('Last iteration note: Updated prompt builder coverage.');
    // The legacy `{{verificationCommands}}` placeholder is replaced with a
    // generic instruction rather than a hardcoded npm command list.
    expect(value).not.toContain('npm run lint');
    expect(value).not.toContain('npm run typecheck');
    expect(value).not.toContain('npm run test');
    expect(value).toMatch(/lint(?:ing)?/i);
  });

  it('uses a first-iteration summary when there is no previous iteration', async () => {
    const prompt = await buildIterationPrompt({
      config: createConfig(),
      iterationIndex: 1,
      previousIteration: null,
      readFile: async () => 'Current plan snapshot',
    });

    expect(prompt).toContain('This is the first iteration.');
  });

  it('includes the current plan document content in the default prompt template', async () => {
    const prompt = await buildIterationPrompt({
      config: createConfig({
        promptTemplate: getDefaultPromptTemplate(),
      }),
      iterationIndex: 4,
      previousIteration: null,
      readFile: async () => '# Ralph Plan\n- [ ] add prompt coverage',
    });

    expect(prompt).toContain('Current plan document content:');
    expect(prompt).toContain('# Ralph Plan\n- [ ] add prompt coverage');
    // Default prompt no longer hardcodes verification commands.
    expect(prompt).not.toContain('npm run lint');
    expect(prompt).not.toContain('npm run typecheck');
    expect(prompt).toContain('Ralph manager will request verification commands separately');
  });

  it('warns that absolute plan document paths may be outside the workspace', async () => {
    const prompt = await buildIterationPrompt({
      config: createConfig({
        planDocPath: '/Users/andrew/.config/opencode/plans/plan.md',
        promptTemplate: getDefaultPromptTemplate(),
      }),
      iterationIndex: 1,
      previousIteration: null,
      readFile: async () => '# External Plan',
    });

    expect(prompt).toContain(
      'If the plan document path is absolute, it may be outside the current workspace.'
    );
    expect(prompt).toContain('Read and update that exact path');
    expect(prompt).toContain('do not create or update a same-named file inside the workspace');
  });

  it('builds an anchor message that summarizes the configured run', () => {
    const message = buildAnchorMessage(
      createConfig({
        planDocPath: 'plans/feature.md',
        iterations: 3,
        model: {
          providerID: 'openai',
          modelID: 'gpt-5.4',
          variant: 'high',
        },
      })
    );

    expect(message).toContain('Plan document: plans/feature.md');
    expect(message).toContain('Iterations: up to 3');
    expect(message).toContain('Permission mode: full');
    expect(message).toContain('Model: openai/gpt-5.4 (high)');
    expect(message).toMatch(/Verification: /);
    // No hardcoded command list — the model is asked to detect what the
    // project supports.
    expect(message).not.toContain('npm run');
  });
});

describe('parent-driven verification prompts', () => {
  it('builds a follow-up verification prompt that asks for project-detected commands', () => {
    const prompt = buildVerificationPrompt(createConfig());
    expect(prompt).toContain('Ralph manager is requesting verification');
    // Generic guidance rather than hardcoded npm scripts.
    expect(prompt).not.toContain('npm run lint');
    expect(prompt).not.toContain('npm run typecheck');
    expect(prompt).not.toContain('npm run test');
    expect(prompt).toMatch(/lint/i);
    expect(prompt).toMatch(/test/i);
    // No fixed name list — the model picks short names that fit the project.
    expect(prompt).not.toMatch(/Use the names:/);
    expect(prompt).toMatch(/short, lowercase names/i);
  });

  it('builds a repair sub-agent prompt with failure context and generic verification guidance', () => {
    const failed = createIteration({
      index: 3,
      verification: { lint: 'pass', typecheck: 'fail', test: 'fail' },
      filesChanged: ['src/a.ts', 'src/b.ts'],
      note: 'Iteration changed types but tsc reported 3 errors.',
    });
    const prompt = buildRepairSubAgentPrompt({
      config: createConfig(),
      failedIteration: failed,
      attempt: 1,
      maxAttempts: 2,
    });
    expect(prompt).toContain('Ralph repair sub-agent for iteration #3 (attempt 1 of 2)');
    expect(prompt).toContain('verification failed for: typecheck, test');
    expect(prompt).toContain('Files changed by the iteration:');
    expect(prompt).toContain('- src/a.ts');
    expect(prompt).toContain('- src/b.ts');
    expect(prompt).toContain('Iteration summary:');
    expect(prompt).not.toContain('npm run lint');
    expect(prompt).toMatch(/lint/i);
    expect(prompt).toContain('Plan document path: RALPH.md');
  });
});

describe('readPlanDocument', () => {
  it('returns fallback text when the plan file cannot be read', async () => {
    await expect(readPlanDocument('RALPH.md')).resolves.toBe(
      '(Plan document content unavailable.)'
    );
    await expect(readPlanDocument('RALPH.md', async () => null)).resolves.toBe(
      '(Plan document content unavailable.)'
    );
    await expect(readPlanDocument('RALPH.md', async () => '')).resolves.toBe(
      '(Plan document is empty.)'
    );
  });
});
