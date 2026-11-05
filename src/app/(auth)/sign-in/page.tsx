import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getSession, isSafeRedirectPath } from "@/lib/server/auth";

import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = {
  title: "Sign in — CustomsDoc AI",
  description: "Sign in to the CustomsDoc AI documentation workspace.",
};

// This route deliberately serves a dynamic (blocking) shell: the redirect
// decision and the `?next=` handling depend on request cookies/headers via
// getSession(), which cannot be prerendered into a static shell.
// `instant = false` opts this segment out of instant-navigation validation
// without disabling Cache Components or caching the session data.
export const instant = false;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SignInPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  // Server-side session check: a valid existing session short-circuits the
  // login form. Never trusts client-side session state.
  const session = await getSession();
  if (session) {
    redirect("/");
  }

  const params = await searchParams;
  const rawNext = typeof params.next === "string" ? params.next : null;
  const nextPath = rawNext && isSafeRedirectPath(rawNext) ? rawNext : null;

  return (
    <div className="flex flex-col gap-6 rounded-xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Sign in
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Access your CustomsDoc AI documentation workspace.
        </p>
      </header>
      <SignInForm nextPath={nextPath} />
      <p className="text-center text-sm text-zinc-500 dark:text-zinc-400">
        Don&apos;t have an account?{" "}
        <Link
          href="/sign-up"
          className="font-medium text-zinc-900 underline-offset-4 hover:underline dark:text-zinc-100"
        >
          Create one
        </Link>
      </p>
    </div>
  );
}
