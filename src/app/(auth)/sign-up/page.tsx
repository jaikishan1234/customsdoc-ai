import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getSession } from "@/lib/server/auth";

import { SignUpForm } from "./sign-up-form";

export const metadata: Metadata = {
  title: "Create account — CustomsDoc AI",
  description: "Register for the CustomsDoc AI documentation workspace.",
};

export default async function SignUpPage() {
  // Server-side session check: an authenticated user has no business on the
  // registration page — send them straight to the application.
  const session = await getSession();
  if (session) {
    redirect("/");
  }

  return (
    <div className="flex flex-col gap-6 rounded-xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Create your account
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Join CustomsDoc AI to manage shipments and customs documentation.
        </p>
      </header>
      <SignUpForm />
      <p className="text-center text-sm text-zinc-500 dark:text-zinc-400">
        Already have an account?{" "}
        <Link
          href="/sign-in"
          className="font-medium text-zinc-900 underline-offset-4 hover:underline dark:text-zinc-100"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
