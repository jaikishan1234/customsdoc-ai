/**
 * Documents tab content — the previous "Documents & uploads" section,
 * restructured per document type: the ACTIVE version is primary, superseded
 * version history is retained behind a collapsed disclosure.
 *
 * Data contract unchanged (listDocumentsForShipment): rows carry provenance
 * names, versions, sizes and timestamps only — never storage keys or
 * checksums. Upload/removal remains API-only today (no upload UI exists on
 * this page before or after this redesign); the API route is untouched.
 */
import {
  formatDocumentTypeLabel,
  formatFileSizeBytes,
} from "@/lib/document-display";
import { formatLongDateTimeUtc } from "@/lib/date-display";
import type {
  DocumentEntryType,
  ShipmentDocumentEntry,
} from "@/lib/services/document-service";

/** pgEnum declaration order (same stabilisation the services use). */
export const REQUIRED_DOCUMENT_TYPES: ReadonlyArray<DocumentEntryType> = [
  "INVOICE",
  "PACKING_LIST",
  "BILL_OF_LADING",
];

const groupEntriesByType = (
  entries: readonly ShipmentDocumentEntry[],
): Array<{
  documentType: DocumentEntryType;
  activeEntry: ShipmentDocumentEntry | null;
  history: ShipmentDocumentEntry[];
}> =>
  REQUIRED_DOCUMENT_TYPES.map((documentType) => {
    const of = entries
      .filter((entry) => entry.documentType === documentType)
      .sort((first, second) => second.version - first.version);
    return {
      documentType,
      activeEntry: of.find((entry) => entry.isActive) ?? null,
      history: of.filter((entry) => !entry.isActive),
    };
  });

const typeBaseClasses =
  "text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400";

function DocumentVersionRow({
  entry,
  isActive,
}: {
  entry: ShipmentDocumentEntry;
  isActive: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="break-all text-sm font-medium text-zinc-800 dark:text-zinc-100">
          {entry.originalFilename}
        </span>
        <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
          v{entry.version}
        </span>
        <span
          className={
            isActive
              ? "rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
              : "rounded-full border border-zinc-300 bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
          }
        >
          {isActive ? "Active" : "Superseded"}
        </span>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        {formatFileSizeBytes(entry.sizeBytes)} PDF · uploaded{" "}
        {formatLongDateTimeUtc(entry.uploadedAt, "UTC")} by{" "}
        {entry.uploadedBy.name}
        {entry.supersededAt
          ? ` · superseded ${formatLongDateTimeUtc(entry.supersededAt, "UTC")}`
          : null}
      </p>
    </div>
  );
}

export function DocumentsPanel({
  entries,
  unavailable,
}: {
  entries: readonly ShipmentDocumentEntry[];
  unavailable: boolean;
}) {
  if (unavailable) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
        Document data could not be loaded. Please try again.
      </p>
    );
  }

  const groups = groupEntriesByType(entries);

  return (
    <section
      aria-label="Documents"
      className="flex flex-col gap-4"
    >
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        One active version per document type; replacements are versioned and
        superseded history is retained for traceability.
      </p>

      <ol className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
        {groups.map(({ documentType, activeEntry, history }) => (
          <li key={documentType} className="flex flex-col gap-3 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                {formatDocumentTypeLabel(documentType)}
              </h3>
              <span className={typeBaseClasses}>
                {activeEntry ? `v${activeEntry.version} active` : "not uploaded"}
              </span>
            </div>

            {activeEntry ? (
              <DocumentVersionRow entry={activeEntry} isActive />
            ) : (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                No version of this document type has been uploaded yet.
              </p>
            )}

            {history.length > 0 ? (
              <details className="text-xs text-zinc-600 dark:text-zinc-300">
                <summary className="cursor-pointer select-none">
                  Superseded version history ({history.length})
                </summary>
                <div className="mt-2 flex flex-col gap-3 border-l border-zinc-200 pl-3 dark:border-zinc-800">
                  {history.map((entry) => (
                    <DocumentVersionRow
                      key={entry.id}
                      entry={entry}
                      isActive={false}
                    />
                  ))}
                </div>
              </details>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
