/**
 * Horizontal tab navigation for the shipment workspace.
 *
 * Tabs are pure URL state via the `tab` search parameter:
 * - Server-rendered Links only (same pattern as the shipments-list filter
 *   chips) — no new client dependencies, no client state to hydrate.
 * - Refreshing, sharing, back/forward and direct entry all preserve the
 *   selected tab because it lives in the URL, not in component state.
 * - Unknown/missing values parse to Overview (never 404s).
 */
import Link from "next/link";

/** Name of the URL search parameter holding the active tab. */
export const TAB_SEARCH_PARAM = "tab";

export type ShipmentTab = "overview" | "documents" | "extraction" | "activity";

const TAB_ITEMS: ReadonlyArray<{ value: ShipmentTab; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "documents", label: "Documents" },
  { value: "extraction", label: "Extraction & Review" },
  { value: "activity", label: "Activity" },
];

/** Href for a tab: the default tab stays a clean URL. */
export const shipmentTabHref = (
  shipmentId: string,
  tab: ShipmentTab,
): string =>
  tab === "overview"
    ? `/shipments/${shipmentId}`
    : `/shipments/${shipmentId}?${TAB_SEARCH_PARAM}=${tab}`;

/** Strict whitelist parse: anything not exactly a known tab → "overview". */
export const parseShipmentTab = (
  value: string | string[] | undefined,
): ShipmentTab => {
  const raw = (Array.isArray(value) ? value[0] : value) ?? undefined;
  return TAB_ITEMS.find((item) => item.value === raw)?.value ?? "overview";
};

const linkBase =
  "inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition";
const linkActive =
  "border-zinc-900 font-medium text-zinc-900 dark:border-zinc-100 dark:text-zinc-50";
const linkIdle =
  "border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-800 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-200";
const countPill =
  "rounded-full bg-zinc-100 px-1.5 text-[11px] font-medium leading-5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300";

export function ShipmentTabNav({
  shipmentId,
  activeTab,
  documentCount,
  pendingReviewCount,
}: {
  shipmentId: string;
  activeTab: ShipmentTab;
  /** Active document count (Documents tab pill); null when unavailable. */
  documentCount: number | null;
  /** Fields awaiting review (Extraction tab pill); null when unavailable. */
  pendingReviewCount: number | null;
}) {
  return (
    <nav
      aria-label="Shipment sections"
      className="border-b border-zinc-200 dark:border-zinc-800"
    >
      {/* overflow-y is clipped deliberately: with `overflow-x-auto` alone the
          visible vertical axis computes to `auto` (CSS spec), turning this ul
          into a vertical scroll container whose phantom scrollbar (up/down
          arrow controls) appears at the right end of the tab row. The tab
          links' border+borders overlap makes content ~1px taller, so the
          vertical axes must never scroll — clip, don't hide page scrolling. */}
      <ul className="flex gap-1 overflow-x-auto overflow-y-clip sm:gap-2">
        {TAB_ITEMS.map((tab) => {
          const active = tab.value === activeTab;
          const count =
            tab.value === "documents"
              ? documentCount
              : tab.value === "extraction"
                ? pendingReviewCount
                : null;
          return (
            <li key={tab.value} className="-mb-px">
              <Link
                href={shipmentTabHref(shipmentId, tab.value)}
                aria-current={active ? "page" : undefined}
                className={`${linkBase} ${active ? linkActive : linkIdle}`}
              >
                {tab.label}
                {count !== null && count > 0 ? (
                  <span className={countPill}>{count}</span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
