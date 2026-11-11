import type { ExperimentalGenerateDecisionsInput } from '@opencode/client';
import type {
  AutoApproveJudgeReference,
  AutoApproveJudgeResponse,
  DecisionProviderStatus,
} from '../shared/protocol';
import { asRecord, isNumber, isString, type UnknownRecord } from '../shared/type-utils';
import type { OpenCodeServer } from './server';
import { parseModelRoute } from './sidebar-provider-utils';
import { gatePermissionDecision, permissionDecisionQuestions } from './jev-decisions';
import { tracePrompt } from './prompt-trace';

const DECISION_PATH = '/api/experimental/generate/decisions';

/** Explicitly opted-in server-owned decisions. No credentials or sessions are created locally. */
export class NativeDecisions {
  constructor(
    private readonly server: Pick<OpenCodeServer, 'request' | 'apiVersion'>,
    private readonly getConfiguredModel: () => string
  ) {}

  get model() {
    return this.server.apiVersion === 2 ? parseModelRoute(this.getConfiguredModel()) : null;
  }

  async status(): Promise<NonNullable<DecisionProviderStatus['native']>> {
    const model = this.model;
    if (this.server.apiVersion !== 2) return { supported: false, model: null, models: [] };
    try {
      const signal = AbortSignal.timeout(5000);
      if (!(await this.supported(signal))) return { supported: false, model, models: [] };
      const response = asRecord(
        await this.server.request('GET', '/api/model?types=decision', undefined, {
          signal,
          unscoped: true,
          maxResponseBytes: 1024 * 1024,
        })
      );
      if (!Array.isArray(response?.data)) throw new Error('Invalid decision model catalog');
      const models = response.data.flatMap((value) => {
        const item = asRecord(value);
        return item?.type === 'decision' &&
          item.enabled !== false &&
          isString(item.providerID) &&
          isString(item.id) &&
          isString(item.name)
          ? [{ providerID: item.providerID, modelID: item.id, name: item.name }]
          : [];
      });
      return { supported: true, model, models };
    } catch (error) {
      return {
        supported: false,
        model,
        models: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async judgePermission(
    model: NonNullable<NativeDecisions['model']>,
    permission: UnknownRecord,
    priorUserDecisions: AutoApproveJudgeReference[]
  ): Promise<AutoApproveJudgeResponse> {
    if (this.server.apiVersion !== 2) throw new Error('Native decisions require OpenCode V2');
    const signal = AbortSignal.timeout(5000);
    if (!(await this.supported(signal)))
      throw new Error('Native decision generation is unavailable');
    const questions: ExperimentalGenerateDecisionsInput['questions'] = Object.entries(
      permissionDecisionQuestions()
    ).map(([name, question]) =>
      question.type === 'choice'
        ? {
            type: 'choice',
            name,
            instructions: question.instructions,
            choices: Object.entries(question.criteria).map(([value, description]) => ({
              value,
              description,
            })),
          }
        : { type: 'predicate', name, instructions: question.instructions }
    );
    const body: ExperimentalGenerateDecisionsInput = {
      model: { providerID: model.providerID, id: model.modelID },
      input: [
        {
          type: 'text',
          text: await tracePrompt(this.server, {
            purpose: 'permission-judge',
            sessionID: isString(permission.sessionID) ? permission.sessionID : undefined,
            requestID: isString(permission.id) ? permission.id : undefined,
            signal,
            prompt: JSON.stringify({ permission, priorUserDecisions }),
          }),
        },
      ],
      questions,
    };
    const response = await this.server.request('POST', DECISION_PATH, body, {
      signal,
      unscoped: true,
      maxResponseBytes: 64 * 1024,
    });
    signal.throwIfAborted();
    const answers = asRecord(asRecord(response)?.data)?.answers;
    if (!Array.isArray(answers) || answers.length !== 3)
      throw new Error('Invalid native permission decisions');
    const indexed = new Map(
      answers.map((value) => {
        const answer = asRecord(value);
        return [answer?.name, answer] as const;
      })
    );
    const decision = indexed.get('decision');
    const destructive = indexed.get('destructive');
    const manipulation = indexed.get('manipulation');
    if (
      indexed.size !== 3 ||
      decision?.type !== 'choice' ||
      !isString(decision.choice) ||
      !['allow', 'ask', 'reject'].includes(decision.choice) ||
      !probability(decision.confidence) ||
      !Array.isArray(decision.probabilities) ||
      decision.probabilities.length !== 3 ||
      destructive?.type !== 'predicate' ||
      !probability(destructive.probability) ||
      manipulation?.type !== 'predicate' ||
      !probability(manipulation.probability)
    )
      throw new Error('Invalid native permission decisions');
    const probabilities: Record<string, number> = {};
    for (const value of decision.probabilities) {
      const entry = asRecord(value);
      if (
        !isString(entry?.value) ||
        !['allow', 'ask', 'reject'].includes(entry.value) ||
        Object.hasOwn(probabilities, entry.value) ||
        !probability(entry.probability)
      )
        throw new Error('Invalid native decision probabilities');
      probabilities[entry.value] = entry.probability;
    }
    return gatePermissionDecision(
      {
        decision: {
          type: 'choice',
          choice: decision.choice,
          confidence: decision.confidence,
          probabilities,
        },
        destructive: { type: 'noul', noul: destructive.probability },
        manipulation: { type: 'noul', noul: manipulation.probability },
      },
      priorUserDecisions
    );
  }

  private async supported(signal: AbortSignal) {
    const spec = asRecord(
      await this.server.request('GET', '/openapi.json', undefined, {
        signal,
        unscoped: true,
        maxResponseBytes: 4 * 1024 * 1024,
      })
    );
    return !!asRecord(asRecord(asRecord(spec?.paths)?.[DECISION_PATH])?.post);
  }
}

function probability(value: unknown): value is number {
  return isNumber(value) && Number.isFinite(value) && value >= 0 && value <= 1;
}
