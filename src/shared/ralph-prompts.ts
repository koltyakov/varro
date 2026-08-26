import type { RalphConfig, RalphIteration } from './ralph';

/**
 * Verification names are intentionally NOT hardcoded. Each project decides
 * which checks make sense (lint, test, build, typecheck, fmt, clippy, vet,
 * mypy, …) and the model reports whatever it ran. The parent parses any
 * `<name>: PASS|FAIL|SKIPPED` lines back out of the report.
 */
const VERIFICATION_EXAMPLES = 'lint, test, build, typecheck, fmt';

const GENERIC_VERIFICATION_INSTRUCTION =
  'Inspect the workspace and choose verification that matches the nature of the change and the files touched. Run only checks that can validate that work; for example, do not run linting when no corresponding code files changed. Skip unrelated checks and checks the project does not configure. Do not invent checks the project does not support. If a relevant check already ran and its result was reported, do not run it again unless matching files changed afterward.';

export const DEFAULT_RALPH_PROMPT_TEMPLATE = `You are iteration {{iteration}} of {{totalIterations}} in a Ralph loop driven from a plan document.

Plan document path: {{planPath}}
{{planPathWarning}}

Current plan document content:
{{planContent}}

{{previousSummary}}

Your task this iteration:
1. Read the plan document at {{planPath}}.
2. Select the first incomplete plan item you can act on. Never repeat a completed item, and do not attempt the whole plan.
3. Finish that item or make a concrete, documented advance toward it. If it is already satisfied and needs no code changes, verify that fact and mark it complete in this iteration.
4. Update the plan document - mark completed work as done (e.g., flip [ ] to [x]) or record the concrete progress made. Do not spend an iteration only inspecting or verifying without updating the plan.
5. Before ending, reread the plan and confirm that this iteration changed either the selected item's status or its documented progress. If no actionable progress is possible, report the blocker instead of claiming success.
6. If the final plan item is complete, add the marker DONE on its own line at the top of the plan document immediately.
7. End with a short summary of what you changed.

The Ralph manager will review verification separately after this turn. Do not run verification yourself unless you need it to confirm the work is correct. If you do run a check, include its command and result in your summary so the manager does not ask for the same check again.

Constraints:
- Do not exceed roughly 30 minutes of work.
- If the plan is already fully complete, write the marker DONE on its own line at the top of the plan document and stop.
- Do not ask questions; you have full permission to read, edit, and run shell commands.`;

export function getDefaultPromptTemplate(): string {
  return DEFAULT_RALPH_PROMPT_TEMPLATE;
}

export async function buildIterationPrompt(args: {
  config: RalphConfig;
  iterationIndex: number;
  previousIteration: RalphIteration | null;
  readFile?: (path: string) => Promise<string | null>;
}): Promise<string> {
  const { config, iterationIndex, previousIteration, readFile } = args;
  const previousSummary = previousIteration
    ? formatPreviousSummary(previousIteration)
    : 'This is the first iteration.';
  const planContent = await readPlanDocument(config.planDocPath, readFile);
  const planPathWarning = getPlanPromptWarnings(config.planDocPath, planContent);

  return (
    config.promptTemplate
      .replaceAll('{{iteration}}', String(iterationIndex))
      .replaceAll('{{totalIterations}}', String(config.iterations))
      .replaceAll('{{planPath}}', config.planDocPath)
      .replaceAll('{{planPathWarning}}', planPathWarning)
      .replaceAll('{{planContent}}', planContent)
      // Backwards compat: older custom templates may still reference this
      // placeholder. Replace it with the generic instruction so the model
      // still gets useful guidance instead of the literal `{{...}}` token.
      .replaceAll('{{verificationCommands}}', GENERIC_VERIFICATION_INSTRUCTION)
      .replaceAll('{{previousSummary}}', previousSummary)
  );
}

function getPlanPromptWarnings(path: string, planContent: string): string {
  const warnings: string[] = [];
  if (isAbsolutePath(path)) {
    warnings.push(
      'If the plan document path is absolute, it may be outside the current workspace. Read and update that exact path; do not create or update a same-named file inside the workspace.'
    );
  }
  if (isUnavailablePlanContent(planContent) || isEmptyPlanContent(planContent)) {
    warnings.push(
      'If the plan document content is unavailable or empty, do not invent plan work. Retry reading the exact path, and if it still cannot be read, report the blocker and stop without making code changes.'
    );
  }
  return warnings.join('\n');
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path);
}

export async function readPlanDocument(
  path: string,
  readFile?: (path: string) => Promise<string | null>
): Promise<string> {
  if (!readFile) return '(Plan document content unavailable.)';
  try {
    const content = await readFile(path);
    if (content === null) return '(Plan document content unavailable.)';
    if (content.trim().length === 0) return '(Plan document is empty.)';
    return content;
  } catch {
    return '(Plan document content unavailable.)';
  }
}

function isUnavailablePlanContent(content: string): boolean {
  return content === '(Plan document content unavailable.)';
}

function isEmptyPlanContent(content: string): boolean {
  return content === '(Plan document is empty.)';
}

function formatPreviousSummary(previous: RalphIteration): string {
  const verdicts = Object.entries(previous.verification)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
  const note = previous.note ? `\nLast iteration note: ${previous.note}` : '';
  return `Previous iteration #${previous.index} status: ${previous.status}${verdicts ? ` (${verdicts})` : ''}.${note}`;
}

/**
 * Build the follow-up message the parent sends to the iteration's child
 * session asking it to run whatever verification commands the project
 * supports and report each as PASS, FAIL, or SKIPPED. Verification is
 * project-driven: the model inspects the workspace and decides what to run.
 */
export function buildVerificationPrompt(_config: RalphConfig): string {
  return [
    'The Ralph manager is requesting verification for the work you just completed.',
    GENERIC_VERIFICATION_INSTRUCTION,
    'Report each verification on its own line in the form `<name>: PASS`, `<name>: FAIL - <one-line cause>`, or `<name>: SKIPPED - <reason>`.',
    `Use short, lowercase names that describe the check (examples: ${VERIFICATION_EXAMPLES}).`,
    'Do not start new plan work in this turn - only run verifications and report verdicts.',
  ].join('\n');
}

/**
 * Prompt for a fresh repair sub-agent spawned after the iteration's child
 * session reported a verification failure.
 */
export function buildRepairSubAgentPrompt(args: {
  config: RalphConfig;
  failedIteration: RalphIteration;
  attempt: number;
  maxAttempts: number;
}): string {
  const { config, failedIteration, attempt, maxAttempts } = args;
  const failures = Object.entries(failedIteration.verification)
    .filter(([, v]) => v === 'fail')
    .map(([name]) => name);
  const filesChanged =
    failedIteration.filesChanged.length > 0
      ? `\nFiles changed by the iteration:\n${failedIteration.filesChanged.map((f) => `- ${f}`).join('\n')}`
      : '';
  const note = failedIteration.note ? `\nIteration summary:\n${failedIteration.note}` : '';
  return [
    `You are a Ralph repair sub-agent for iteration #${failedIteration.index} (attempt ${attempt} of ${maxAttempts}).`,
    `The iteration's verification failed for: ${failures.length > 0 ? failures.join(', ') : 'unknown'}.`,
    `Plan document path: ${config.planDocPath}`,
    filesChanged,
    note,
    '',
    'Your task:',
    '1. Diagnose the failing verification(s) using the workspace and the iteration summary above.',
    '2. Apply the minimal code edits required to fix them. Do not start a new plan chunk; only repair the iteration just completed.',
    `3. Re-run verification. ${GENERIC_VERIFICATION_INSTRUCTION} Report each result on its own line in the form \`<name>: PASS\`, \`<name>: FAIL - <one-line cause>\`, or \`<name>: SKIPPED - <reason>\`. Use short, lowercase names (examples: ${VERIFICATION_EXAMPLES}).`,
    '4. End with a short summary of the fix.',
    '',
    'Do not ask questions; you have full permission to read, edit, and run shell commands.',
  ].join('\n');
}

export function buildAnchorMessage(config: RalphConfig): string {
  const model = config.model
    ? `${config.model.providerID}/${config.model.modelID}${config.model.variant ? ` (${config.model.variant})` : ''}`
    : '(default)';
  return [
    `Ralph loop initialized at ${new Date(config.createdAt).toISOString()}.`,
    `Plan document: ${config.planDocPath}`,
    `Iterations: up to ${config.iterations}`,
    `Permission mode: ${config.permissionMode}`,
    `Model: ${model}`,
    `Verification: ${GENERIC_VERIFICATION_INSTRUCTION}`,
  ].join('\n');
}
