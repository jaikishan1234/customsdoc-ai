/**
 * Readable status badge for shipment lifecycle states.
 *
 * Server-renderable display component — colors/labels are cosmetic only and
 * never used for authorization. Default styling is a safe neutral pill for
 * any unknown status value so a new enum entry never renders raw text
 * unstyled.
 */

import {
  type ShipmentStatusValue,
} from "@/lib/services/shipment-service";

const STATUS_STYLES: Record<ShipmentStatusValue, { label: string; className: string }> = {
  DRAFT: {
    label: "Draft",
    className:
      "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400",
  },
  PROCESSING: {
    label: "Processing",
    className:
      "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300",
  },
  REVIEW: {
    label: "Review",
    className:
      "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
  },
  AWAITING_APPROVAL: {
    label: "Awaiting approval",
    className:
      "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-300",
  },
  APPROVED: {
    label: "Approved",
    className:
      "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
  },
  REJECTED: {
    label: "Rejected",
    className:
      "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300",
  },
  EXPORTED: {
    label: "Exported",
    className:
      "border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-900 dark:bg-teal-950/40 dark:text-teal-300",
  },
};

const NEUTRAL_FALLBACK = {
  label: null,
  className:
    "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400",
} as const;

export function ShipmentStatusBadge({ status }: { status: string }) {
  const known = STATUS_STYLES[status as ShipmentStatusValue];

  if (!known) {
    // Unknown/future enum value: neutral pill with the raw status text.
    return (
      <span
        className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${NEUTRAL_FALLBACK.className}`}
      >
        {status}
      </span>
    );
  }

  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${known.className}`}
    >
      {known.label}
    </span>
  );
}
