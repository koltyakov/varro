import { asRecord, isNumber, isString } from './type-utils';

export type SessionGoal = {
  id: string;
  objective: string;
  status: 'active' | 'paused' | 'complete';
  reason?: string;
  rounds: number;
  maxRounds: number;
  updatedAt: number;
};

export function parseSessionGoal<T>(value: T): SessionGoal | null {
  const goal = asRecord(value);
  if (
    !goal ||
    !isString(goal.id) ||
    !isString(goal.objective) ||
    (goal.status !== 'active' && goal.status !== 'paused' && goal.status !== 'complete') ||
    (goal.reason !== undefined && !isString(goal.reason)) ||
    !isNumber(goal.rounds) ||
    !Number.isFinite(goal.rounds) ||
    !isNumber(goal.maxRounds) ||
    !Number.isFinite(goal.maxRounds) ||
    !isNumber(goal.updatedAt) ||
    !Number.isFinite(goal.updatedAt)
  )
    return null;
  return {
    id: goal.id,
    objective: goal.objective,
    status: goal.status,
    reason: goal.reason,
    rounds: goal.rounds,
    maxRounds: goal.maxRounds,
    updatedAt: goal.updatedAt,
  };
}
