/**
 * Display-only date/time formatting for server-rendered components.
 *
 * Fixed time zone and explicit locale keep server output deterministic
 * (these components render only on the server, so there is no hydration
 * concern, but determinism across regions still aids caching/debugging).
 */

const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

/** e.g. "5 Nov 2026, 14:32" (UTC). Accepts Date instances. */
export function formatLongDateTimeUtc(
  date: Date,
  labelTimeZone = "UTC",
): string {
  const formatted = dateTimeFormatter.format(date);
  return labelTimeZone === "UTC" ? `${formatted} UTC` : formatted;
}

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeZone: "UTC",
});

/** e.g. "5 Nov 2026" (UTC). */
export function formatDateUtc(date: Date): string {
  return dateFormatter.format(date);
}
