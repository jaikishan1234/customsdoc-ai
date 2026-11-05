"use client";

/**
 * Shipment creation form for /shipments/new.
 *
 * Security model:
 * - The server action re-derives the session and re-validates everything;
 *   client-side field checks here are UX only and never authorization.
 * - No status, user, role, assignment or export field is rendered or sent —
 *   the service owns those exclusively.
 * - Errors shown are always generic, typed messages from the action state;
 *   raw SQL, constraint names or driver errors are never surfaced.
 */

import { useActionState, useEffect, useRef, useState } from "react";

import {
  createShipmentAction,
} from "./actions";
import { initialCreateShipmentActionState } from "./action-state";
import {
  SHIPMENT_DESCRIPTION_MAX_LENGTH,
  SHIPMENT_NOTES_MAX_LENGTH,
  SHIPMENT_REFERENCE_PATTERN,
} from "@/lib/validation/shipment";

const REFERENCE_HINT = "The letters SHP, a hyphen and 4–10 digits (e.g. SHP-24811).";
const REFERENCE_HINT_ID = "reference-hint";

const inputClasses =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 " +
  "outline-none ring-zinc-900/10 transition placeholder:text-zinc-400 focus:border-zinc-400 " +
  "focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 " +
  "dark:text-zinc-100 dark:focus:border-zinc-500";
const labelClasses =
  "block text-sm font-medium text-zinc-700 dark:text-zinc-300";
const errorClasses = "mt-1 text-xs text-red-600 dark:text-red-400";
const hintClasses = "mt-1 text-xs text-zinc-500 dark:text-zinc-400";

type FieldKey = "reference" | "description" | "notes";

/**
 * Client-side pre-validation is instant feedback only (the action's service
 * re-validates server-side, including normalization like trailing spaces).
 */
const validateLocally = (values: Record<FieldKey, string>) => {
  const errors: Partial<Record<FieldKey, string>> = {};

  const trimmedReference = values.reference.trim();
  if (trimmedReference.length === 0) {
    errors.reference = "Reference is required (e.g. SHP-24811).";
  } else if (!SHIPMENT_REFERENCE_PATTERN.test(trimmedReference.toUpperCase())) {
    errors.reference =
      "Reference must be the letters SHP followed by a hyphen and 4–10 digits (e.g. SHP-24811).";
  }

  if (values.description.trim().length > SHIPMENT_DESCRIPTION_MAX_LENGTH) {
    errors.description = `Description must be ${SHIPMENT_DESCRIPTION_MAX_LENGTH} characters or fewer.`;
  }
  if (values.notes.trim().length > SHIPMENT_NOTES_MAX_LENGTH) {
    errors.notes = `Notes must be ${SHIPMENT_NOTES_MAX_LENGTH} characters or fewer.`;
  }

  return errors;
};

export function ShipmentCreateForm() {
  // React 19 action state: one submission at a time, errors structured.
  const [state, formAction, isPending] = useActionState(
    createShipmentAction,
    initialCreateShipmentActionState,
  );

  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<FieldKey, string>>
  >({});

  // Merge server-side field errors into local ones so they clear as soon as
  // the user revises the field (same behavior as the auth forms). Use a ref
  // to skip re-runs after the user edited fields following a failed submit.
  const lastServerErrorsRef = useRef(state.errors);
  useEffect(() => {
    const serverErrors = state.errors;
    if (!serverErrors || serverErrors === lastServerErrorsRef.current) return;
    lastServerErrorsRef.current = serverErrors;
    setFieldErrors((current) => {
      const next = { ...current };
      for (const key of ["reference", "description", "notes"] as const) {
        const message = serverErrors[key];
        if (typeof message === "string") next[key] = message;
      }
      return next;
    });
  }, [state]);

  const handleFieldChange = (fieldKey: FieldKey, value: string) => {
    if (fieldKey === "reference") setReference(value);
    else if (fieldKey === "description") setDescription(value);
    else setNotes(value);

    setFieldErrors((current) => {
      if (!current[fieldKey]) return current;
      const next = { ...current };
      delete next[fieldKey];
      return next;
    });
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    // Duplicate-submit protection: while isPending the action cannot start a
    // second run (React enforces this for action-based forms too); local UI
    // state feedback plus disabled inputs complete the guard.
    if (isPending) {
      event.preventDefault();
      return;
    }

    const errors = validateLocally({ reference, description, notes });
    if (Object.keys(errors).length > 0) {
      event.preventDefault(); // block navigation before the action runs
      setFieldErrors(errors);
    }
  };

  // Server-side field errors were merged into local state by the effect
  // above; this renders local (client or server-sourced) messages only.
  const fieldMessage = (
    fieldKey: FieldKey,
    id: string,
  ): { message: string | undefined; id: string | undefined } => ({
    message: fieldErrors[fieldKey],
    id: fieldErrors[fieldKey] ? id : undefined,
  });

  const referenceError = fieldMessage("reference", "reference-error");
  const descriptionError = fieldMessage("description", "description-error");
  const notesError = fieldMessage("notes", "notes-error");

  const generalError =
    state.status === "unexpected_error"
      ? "Something went wrong while creating the shipment. Please try again."
      : null;

  return (
    <form
      action={formAction}
      onSubmit={handleSubmit}
      className="flex flex-col gap-4"
      noValidate
      aria-busy={isPending}
    >
      <div>
        <label htmlFor="reference" className={labelClasses}>
          Reference
        </label>
        <input
          id="reference"
          name="reference"
          type="text"
          required
          value={reference}
          onChange={(event) => handleFieldChange("reference", event.target.value)}
          disabled={isPending}
          aria-invalid={Boolean(referenceError.message)}
          aria-describedby={`${REFERENCE_HINT_ID}${referenceError.id ? ` ${referenceError.id}` : ""}`}
          placeholder="SHP-24811"
          maxLength={15} // SHP- + 10 digits, one buffer char
          className={inputClasses}
        />
        {referenceError.message && (
          <p id={referenceError.id} className={errorClasses}>
            {referenceError.message}
          </p>
        )}
        <p id={REFERENCE_HINT_ID} className={hintClasses}>
          {REFERENCE_HINT}
        </p>
      </div>

      <div>
        <label htmlFor="description" className={labelClasses}>
          Description <span className="font-normal text-zinc-400">(optional)</span>
        </label>
        <textarea
          id="description"
          name="description"
          rows={3}
          value={description}
          onChange={(event) =>
            handleFieldChange("description", event.target.value)
          }
          disabled={isPending}
          aria-invalid={Boolean(descriptionError.message)}
          aria-describedby={
            descriptionError.message
              ? descriptionError.id
              : "description-limit"
          }
          placeholder="What is being shipped? Goods, route, consignee context…"
          className={`${inputClasses} resize-y`}
        />
        {descriptionError.message ? (
          <p id={descriptionError.id} className={errorClasses}>
            {descriptionError.message}
          </p>
        ) : (
          <p id="description-limit" className={hintClasses}>
            {description.trim().length}/{SHIPMENT_DESCRIPTION_MAX_LENGTH} characters
          </p>
        )}
      </div>

      <div>
        <label htmlFor="notes" className={labelClasses}>
          Notes <span className="font-normal text-zinc-400">(optional)</span>
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={4}
          value={notes}
          onChange={(event) => handleFieldChange("notes", event.target.value)}
          disabled={isPending}
          aria-invalid={Boolean(notesError.message)}
          aria-describedby={notesError.message ? notesError.id : "notes-limit"}
          placeholder="Internal notes for the documentation team…"
          className={`${inputClasses} resize-y`}
        />
        {notesError.message ? (
          <p id={notesError.id} className={errorClasses}>
            {notesError.message}
          </p>
        ) : (
          <p id="notes-limit" className={hintClasses}>
            {notes.trim().length}/{SHIPMENT_NOTES_MAX_LENGTH} characters
          </p>
        )}
      </div>

      {generalError && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {generalError}
        </div>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="mt-1 flex h-10 w-full items-center justify-center rounded-full bg-zinc-900 px-5 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {isPending ? "Creating shipment…" : "Create shipment"}
      </button>
    </form>
  );
}
