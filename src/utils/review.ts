import type { DecisionSnapshot } from '../store/types';
import { potOdds } from '../engine/odds';
import { BB_CHIPS } from '../engine/gameTypes';

export type Verdict = 'good' | 'ok' | 'bad';

export interface DecisionReview {
  /** EV (chips) of the action the hero actually took. */
  chosenEV: number;
  /** EV (chips) of the best available action by the model. */
  bestEV: number;
  bestAction: 'fold' | 'call' | 'raise';
  /** How much EV (in BB) the chosen action left on the table vs the best. */
  gapBB: number;
  verdict: Verdict;
  comment: string;
}

const RAISE_KINDS = new Set(['raise', 'bet', 'allin']);

/** EV of the action the hero chose, mapped onto the three modelled options. */
function chosenActionEV(d: DecisionSnapshot): number {
  if (d.chosen === 'fold') return d.evFold;
  if (RAISE_KINDS.has(d.chosen)) return d.evRaiseHint;
  return d.evCall; // check / call
}

/**
 * Evaluate a single hero decision: compare the chosen line against fold / call /
 * raise EV and classify how reasonable it was. EVs are coarse model estimates
 * (especially the raise hint), so thresholds are intentionally forgiving.
 */
export function reviewDecision(d: DecisionSnapshot): DecisionReview {
  const options: { action: 'fold' | 'call' | 'raise'; ev: number }[] = [
    { action: 'fold', ev: d.evFold },
    { action: 'call', ev: d.evCall },
    { action: 'raise', ev: d.evRaiseHint },
  ];
  const best = options.reduce((a, b) => (b.ev > a.ev ? b : a));
  const chosenEV = chosenActionEV(d);
  const gapBB = Math.max(0, (best.ev - chosenEV) / BB_CHIPS);

  let verdict: Verdict;
  if (gapBB <= 0.5) verdict = 'good';
  else if (gapBB <= 2) verdict = 'ok';
  else verdict = 'bad';

  return {
    chosenEV,
    bestEV: best.ev,
    bestAction: best.action,
    gapBB,
    verdict,
    comment: buildComment(d, best.action, verdict),
  };
}

function buildComment(d: DecisionSnapshot, bestAction: string, verdict: Verdict): string {
  const odds = d.toCall > 0 ? potOdds(d.potBefore, d.toCall) : 0;
  const eqPct = (d.equity * 100).toFixed(0);

  if (d.chosen === 'fold') {
    if (verdict === 'good') return `弃牌合理：跟注为负 EV（胜率 ${eqPct}%）。`;
    return `这里弃牌偏紧，胜率 ${eqPct}% 时${bestActionLabel(bestAction)}期望更高。`;
  }

  if (d.chosen === 'call' || d.chosen === 'check') {
    if (d.toCall > 0) {
      if (d.equity >= odds) {
        return verdict === 'good'
          ? `跟注合理：胜率 ${eqPct}% ≥ 底池赔率 ${(odds * 100).toFixed(0)}%。`
          : `跟注可行，但${bestActionLabel(bestAction)}期望更高。`;
      }
      return `胜率 ${eqPct}% 低于底池赔率 ${(odds * 100).toFixed(0)}%，跟注偏松，弃牌更稳。`;
    }
    return verdict === 'good'
      ? `过牌稳健（胜率 ${eqPct}%）。`
      : `胜率 ${eqPct}%，更主动地下注价值/施压期望更高。`;
  }

  // raise / bet / allin
  if (verdict === 'good') return `加注合理：以 ${eqPct}% 胜率施压/取价值。`;
  if (d.equity < 0.35) return `偏激进的下注/加注（胜率仅 ${eqPct}%），属诈唬，需谨慎控制频率。`;
  return `下注/加注尚可，但${bestActionLabel(bestAction)}在此局面期望更高。`;
}

function bestActionLabel(a: string): string {
  return { fold: '弃牌', call: '跟注', raise: '加注' }[a] ?? a;
}

export const VERDICT_META: Record<Verdict, { label: string; cls: string; dot: string }> = {
  good: { label: '合理', cls: 'text-emerald-300', dot: 'bg-emerald-500' },
  ok: { label: '可改进', cls: 'text-amber-300', dot: 'bg-amber-500' },
  bad: { label: '失误', cls: 'text-rose-300', dot: 'bg-rose-500' },
};
