/**
 * Kept as the AI-facing import path; the implementation lives in engine so the
 * Monte-Carlo range sampler and the decision layer use one identical ordering.
 */
export {
  preflopAllInPercentile,
  preflopAllInScore,
  preflopPercentile,
  preflopScore,
  startingHandClass,
  isSuitedAce,
  isSuitedConnector,
  PLAYABILITY_ORDER,
} from '../engine/preflopStrength';
