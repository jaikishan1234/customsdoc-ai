import Link from "next/link";

export const metadata = {
  title: "Access denied — CustomsDoc AI",
  description: "You do not have permission to access this resource.",
};

/**
 * Default destination for requireRole()/requireManager() when the
 * authenticated user's role is not permitted for the requested resource.
 */
export default function ForbiddenPage() {
  return (
    <div className="flex min-h-[calc(100vh)] flex-1 items-center justify-center bg-zinc-50 px-4 py-12 font-sans dark:bg-black">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Access denied
        </h1>
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
          Your account is not permitted to access the requested resource. If
          you believe this is an error, contact your documentation manager.
        </p>
        <Link
          href="/"
          className="mt-6 flex h-10 w-full items-center justify-center rounded-full bg-zinc-900 px-5 text-sm font-medium text-white transition hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Back to home
        </Link>
      </div>
    </div>
  );
}
