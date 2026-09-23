/**
 * Kept as the AI-facing import path; the implementation lives in engine so the
 * Monte-Carlo range sampler and the decision layer use one identical ordering.
 */
export {
  preflopPercentile,
  preflopScore,
  startingHandClass,
  isSuitedAce,
  isSuitedConnector,
} from '../engine/preflopStrength';
