"use client";

/**
 * Registration form for /sign-up.
 *
 * Security model:
 * - No role field: the server-side Better Auth configuration owns `role`
 *   (`input: false`, default DOCUMENTATION_EXECUTIVE). Nothing here can
 *   influence it.
 * - Password is never logged; it lives only in local component state until
 *   submitted to the auth endpoint.
 */

import { useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { authClient } from "@/lib/auth-client";

// Keep in sync with Better Auth server defaults (better-auth 1.7.16:
// minPasswordLength 8, maxPasswordLength 128).
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;

type FieldKey = "name" | "email" | "password" | "confirmPassword";
type FieldErrors = Partial<Record<FieldKey, string>>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EMAIL_ERROR =
  "Enter a valid email address (e.g. name@company.com).";
const PASSWORD_RULES_ERROR = `Password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters long.`;
const CONFIRMED_ERROR = "Passwords do not match.";

const inputClasses =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 " +
  "outline-none ring-zinc-900/10 transition placeholder:text-zinc-400 focus:border-zinc-400 " +
  "focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 " +
  "dark:text-zinc-100 dark:focus:border-zinc-500";
const labelClasses =
  "block text-sm font-medium text-zinc-700 dark:text-zinc-300";
const errorClasses = "mt-1 text-xs text-red-600 dark:text-red-400";

export function SignUpForm() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const validate = (): FieldErrors => {
    const errors: FieldErrors = {};

    if (name.trim().length < 2) {
      errors.name = "Enter your full name (at least 2 characters).";
    }

    const trimmedEmail = email.trim();
    if (trimmedEmail.length === 0) {
      errors.email = "Email is required.";
    } else if (!EMAIL_PATTERN.test(trimmedEmail)) {
      errors.email = EMAIL_ERROR;
    }

    if (password.length < PASSWORD_MIN_LENGTH) {
      errors.password = PASSWORD_RULES_ERROR;
    } else if (password.length > PASSWORD_MAX_LENGTH) {
      errors.password = PASSWORD_RULES_ERROR;
    } else if (confirmPassword !== password) {
      errors.confirmPassword = CONFIRMED_ERROR;
    }

    return errors;
  };

  const handleFieldChange =
    (fieldKey: FieldKey, onChange: (value: string) => void) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange(event.target.value);
      // Clear the field's error as the user revises it.
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
      const { error } = await authClient.signUp.email({
        name: name.trim(),
        email: email.trim(),
        password,
      });

      if (error) {
        // User-facing message from the server; never internally logged with
        // credentials included.
        setFormError(
          error.message ??
            "Registration failed. Please check your details and try again.",
        );
        return;
      }

      // Sign-up establishes a session server-side (email verification is
      // disabled in this MVP) — go to the authenticated app root.
      router.replace("/");
      router.refresh();
    } catch {
      // Network/server transport failures.
      setFormError("Registration failed. Please try again.");
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
        <label htmlFor="name" className={labelClasses}>
          Full name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          required
          value={name}
          onChange={handleFieldChange("name", setName)}
          disabled={isSubmitting}
          aria-invalid={Boolean(fieldErrors.name)}
          aria-describedby={fieldErrors.name ? fieldErrorId("name") : undefined}
          placeholder="Jane Fernandes"
          className={inputClasses}
        />
        {fieldErrors.name && (
          <p id={fieldErrorId("name")} className={errorClasses}>
            {fieldErrors.name}
          </p>
        )}
      </div>

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
          autoComplete="new-password"
          required
          value={password}
          onChange={handleFieldChange("password", setPassword)}
          disabled={isSubmitting}
          aria-invalid={Boolean(fieldErrors.password)}
          aria-describedby={`${fieldErrorId("password")} password-hint`}
          placeholder="At least 8 characters"
          className={inputClasses}
        />
        {fieldErrors.password && (
          <p id={fieldErrorId("password")} className={errorClasses}>
            {fieldErrors.password}
          </p>
        )}
        <p
          id="password-hint"
          className="mt-1 text-xs text-zinc-500 dark:text-zinc-400"
        >
          {PASSWORD_MIN_LENGTH}-{PASSWORD_MAX_LENGTH} characters.
        </p>
      </div>

      <div>
        <label htmlFor="confirm-password" className={labelClasses}>
          Confirm password
        </label>
        <input
          id="confirm-password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={handleFieldChange("confirmPassword", setConfirmPassword)}
          disabled={isSubmitting}
          aria-invalid={Boolean(fieldErrors.confirmPassword)}
          aria-describedby={
            fieldErrors.confirmPassword
              ? fieldErrorId("confirmPassword")
              : undefined
          }
          placeholder="Re-enter your password"
          className={inputClasses}
        />
        {fieldErrors.confirmPassword && (
          <p id={fieldErrorId("confirmPassword")} className={errorClasses}>
            {fieldErrors.confirmPassword}
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
        {isSubmitting ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
