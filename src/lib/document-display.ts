/**
 * Display-only formatting for shipment documents (server-renderable).
 *
 * Pure helpers, mirroring `date-display.ts` conventions: deterministic
 * output, no imports from services or storage, and a safe fallback for any
 * unknown value so future schema additions never render unstyled/raw.
 */

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  INVOICE: "Invoice",
  PACKING_LIST: "Packing list",
  BILL_OF_LADING: "Bill of lading",
};

/** Human label for a document type; unknown values pass through untouched. */
export function formatDocumentTypeLabel(documentType: string): string {
  return DOCUMENT_TYPE_LABELS[documentType] ?? documentType;
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB"] as const;

/**
 * File size in binary units (matches the exact byte physics used by the
 * upload limit, 1 KiB = 1024 B). Malformed/negative input renders as "—"
 * instead of a made-up number.
 */
export function formatFileSizeBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return "—";
  }
  let value = sizeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  if (unitIndex === 0) {
    return `${value} ${BYTE_UNITS[0]}`;
  }
  const formatted =
    value >= 100
      ? Math.round(value).toString()
      : value >= 10
        ? value.toFixed(1)
        : value.toFixed(2);
  return `${formatted} ${BYTE_UNITS[unitIndex]}`;
}
