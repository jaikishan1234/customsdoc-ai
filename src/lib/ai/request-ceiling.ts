/**
 * Best-effort per-instance daily request ceiling for extraction provider
 * calls.
 *
 * NOT a global quota: each server process (and every serverless instance)
 * keeps its own module-scope counter, so on multi-instance deployments the
 * effective project-wide cap is `ceiling x instance count`. A durable
 * project-wide limit complements this module — implemented in
 * `src/lib/services/extraction-service.ts` as a per-attempt count of
 * `extractions` rows whose `created_at` falls within the current UTC day
 * (check-then-insert, inherently racy under concurrency — documented there).
 *
 * The ceiling is deliberately INDEPENDENT of Google's free-tier RPM/RPD
 * quotas (their exact free values are unpublished and can change; their RPD
 * resets at midnight Pacific). This fail-safe exists so accidental retry
 * storms can never silently exhaust the provider's daily allowance.
 *
 * Slots are consumed at reserve time regardless of the request outcome — a
 * failed, rejected or rate-limited attempt still occupies a slot,
 * conservatively. The day boundary is UTC (our own policy, not the
 * provider's).
 */

/**
 * Conservative self-imposed daily limit; revisit as the free tier evolves.
 * Exported so the extraction service's durable row-count pre-check and this
 * instance-local fail-safe stay one deliberate number.
 */
export const EXTRACTION_DAILY_REQUEST_CEILING = 40;

const utcDayKey = (): string => new Date().toISOString().slice(0, 10);

let currentDayUtc = utcDayKey();
let requestsUsedToday = 0;

export interface ExtractionCeilingUsage {
  dateUtc: string;
  used: number;
  ceiling: number;
}

/**
 * Reserve one provider request slot. Returns false once the instance-local
 * ceiling for the current UTC day is exhausted. Single-threaded JS makes the
 * check-and-increment atomic in practice.
 */
export const reserveExtractionRequestSlot = (): boolean => {
  const day = utcDayKey();
  if (currentDayUtc !== day) {
    currentDayUtc = day;
    requestsUsedToday = 0;
  }
  if (requestsUsedToday >= EXTRACTION_DAILY_REQUEST_CEILING) {
    return false;
  }
  requestsUsedToday += 1;
  return true;
};

/** Current instance-local usage (diagnostics only — never client-facing). */
export const getExtractionDailyUsage = (): ExtractionCeilingUsage => ({
  dateUtc: currentDayUtc,
  used: requestsUsedToday,
  ceiling: EXTRACTION_DAILY_REQUEST_CEILING,
});
