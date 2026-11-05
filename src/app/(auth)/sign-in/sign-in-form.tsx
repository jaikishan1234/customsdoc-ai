"use client";

/**
 * Sign-in form for /sign-in.
 *
 * Security model:
 * - Credentials are sent only to the Better Auth endpoint; they are never
 *   logged and never leave controlled component state otherwise.
 * - Role is never part of sign-in; authorization is decided server-side by
 *   the session helpers.
 */

import { useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { authClient } from "@/lib/auth-client";

type FieldKey = "email" | "password";
type FieldErrors = Partial<Record<FieldKey, string>>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EMAIL_ERROR = "Enter a valid email address (e.g. name@company.com).";
const PASSWORD_REQUIRED_ERROR = "Password is required.";

const inputClasses =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 " +
  "outline-none ring-zinc-900/10 transition placeholder:text-zinc-400 focus:border-zinc-400 " +
  "focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 " +
  "dark:text-zinc-100 dark:focus:border-zinc-500";
const labelClasses =
  "block text-sm font-medium text-zinc-700 dark:text-zinc-300";
const errorClasses = "mt-1 text-xs text-red-600 dark:text-red-400";

export function SignInForm({ nextPath }: { nextPath?: string | null }) {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const validate = (): FieldErrors => {
    const errors: FieldErrors = {};

    const trimmedEmail = email.trim();
    if (trimmedEmail.length === 0) {
      errors.email = "Email is required.";
    } else if (!EMAIL_PATTERN.test(trimmedEmail)) {
      errors.email = EMAIL_ERROR;
    }

    if (password.length === 0) {
      errors.password = PASSWORD_REQUIRED_ERROR;
    }

    return errors;
  };

  const handleFieldChange =
    (fieldKey: FieldKey, onChange: (value: string) => void) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange(event.target.value);
      setFieldErrors((current) => {
        if (!current[fieldKey]) return current;
        const next = { ...current };
        delete next[fieldKey];
        return next;
      });
    };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return; // guard against duplicate submissions

    setFormError(null);
    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setIsSubmitting(true);
    try {
      const { error } = await authClient.signIn.email({
        email: email.trim(),
        password,
      });

      if (error) {
        // User-facing message from the server (e.g. invalid credentials
        // or rate limiting). Never logged, never embedded with credentials.
        setFormError(
          error.message ??
            "Sign in failed. Please check your email and password.",
        );
        return;
      }

      // Prefer the validated "next" destination (e.g. set by requireSession
      // when a protected page bounced the user here); default to home.
      router.replace(nextPath && nextPath.startsWith("/") ? nextPath : "/");
      router.refresh();
    } catch {
      setFormError("Sign in failed. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const fieldErrorId = (fieldKey: FieldKey) => `${fieldKey}-error`;

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-4"
      noValidate
      aria-busy={isSubmitting}
    >
      <div>
        <label htmlFor="email" className={labelClasses}>
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          value={email}
          onChange={handleFieldChange("email", setEmail)}
          disabled={isSubmitting}
          aria-invalid={Boolean(fieldErrors.email)}
          aria-describedby={fieldErrors.email ? fieldErrorId("email") : undefined}
          placeholder="jane@company.com"
          className={inputClasses}
        />
        {fieldErrors.email && (
          <p id={fieldErrorId("email")} className={errorClasses}>
            {fieldErrors.email}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="password" className={labelClasses}>
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={handleFieldChange("password", setPassword)}
          disabled={isSubmitting}
          aria-invalid={Boolean(fieldErrors.password)}
          aria-describedby={fieldErrors.password ? fieldErrorId("password") : undefined}
          className={inputClasses}
        />
        {fieldErrors.password && (
          <p id={fieldErrorId("password")} className={errorClasses}>
            {fieldErrors.password}
          </p>
        )}
      </div>

      {formError && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {formError}
        </div>
      )}

      <button
        type="submit"
        disabled={isSubmitting}
        className="mt-1 flex h-10 w-full items-center justify-center rounded-full bg-zinc-900 px-5 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {isSubmitting ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
