/**
 * Display-only role formatting.
 *
 * Purely cosmetic: converts a raw role value (e.g. DOCUMENTATION_MANAGER)
 * into a human label ("Documentation Manager"). Never used for
 * authorization decisions — server-side helpers own those.
 */

export function formatRoleLabel(role: string): string {
  const formatted = role
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ")
    .trim();

  return formatted.length > 0 ? formatted : role;
}
