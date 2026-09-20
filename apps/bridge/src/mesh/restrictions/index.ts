export { checkRepository, restrictionSummary } from "./check";
export { runRestrictionsCheck, type RestrictionsCheckResult } from "./cli";
export {
  countLines,
  evaluateContent,
  functionLineCounts,
  pathMatches,
  ruleApplies,
  type RestrictionViolation,
} from "./evaluate";
export {
  loadRestrictions,
  readRepoRestrictions,
  rememberRestrictions,
  repoRestrictionsPath,
  restrictionsPath,
  writeRepoRestrictions,
} from "./store";
export { evaluateWriteRestrictions, writeCandidate } from "./write-gate";
