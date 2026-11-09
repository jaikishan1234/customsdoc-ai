# Deployment & Setup Guide — CustomsDoc AI

Operational setup guide for CustomsDoc AI: local development, environment configuration, database migration, demo accounts, the demo workflow, troubleshooting, and the **not-yet-performed** Vercel deployment.

> Current state (honest status):
> - The application **runs locally** (`http://localhost:3000`) and has been verified end-to-end with **synthetic documents**.
> - It is **NOT deployed** to Vercel or any other host — there is **no public URL**.
> - **No reviewer/demo credentials are provided yet** in this document; demo account placeholders are clearly labelled in §13 and must be filled in before the submission ZIP is finalized.
> - The expensive services are all on free tiers: Neon PostgreSQL, Cloudinary, Google Gemini. **No paid services are required.**

Related: [`README.md`](./README.md) (product overview, architecture, limitations).

---

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Clone the repository](#2-clone-the-repository)
3. [Install dependencies](#3-install-dependencies)
4. [Configure Neon PostgreSQL](#4-configure-neon-postgresql)
5. [Configure Drizzle migrations](#5-configure-drizzle-migrations)
6. [Configure Better Auth](#6-configure-better-auth)
7. [Configure Cloudinary](#7-configure-cloudinary)
8. [Configure Gemini](#8-configure-gemini)
9. [Environment variables (complete list)](#9-environment-variables-complete-list)
10. [Run locally](#10-run-locally)
11. [Build and production commands](#11-build-and-production-commands)
12. [Vercel deployment — NOT YET DEPLOYED](#12-vercel-deployment--not-yet-deployed)
13. [Demo login accounts (Executive / Manager)](#13-demo-login-accounts-executive--manager)
14. [Demo workflow with SHP-24811 and synthetic documents](#14-demo-workflow-with-shp-24811-and-synthetic-documents)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. Prerequisites

| Requirement | Notes |
| --- | --- |
| **Node.js 20+** and npm | `package.json` targets Node 20 types (`@types/node ^20`). No `engines` field is pinned. |
| **Git** | To clone the repository. |
| **Neon account** (free tier) | PostgreSQL database. |
| **Cloudinary account** (free tier) | Private raw PDF storage. |
| **Google AI Studio account** (free tier) | Gemini API key. *No billing account or payment card is required for the free tier.* |
| **Synthetic PDF documents** | Three PDFs (Invoice, Packing List, Bill of Lading) with realistic values. Use synthetic data only — the Gemini adapter is designed for synthetic documents, see §14. |

What this app does **not** need: Docker containers, paid API plans, a separate local PostgreSQL install (Neon is cloud-hosted), or any additional database tooling.

---

## 2. Clone the repository

```bash
git clone https://github.com/jaikishan1234/customsdoc-ai.git
cd customsdoc-ai
```

---

## 3. Install dependencies

```bash
npm install
```

This installs the dependencies declared in `package.json` (no global installs are needed): `next`, `react`/`react-dom`, `drizzle-orm`, `@neondatabase/serverless`, `better-auth`, `cloudinary`, `server-only`, plus dev tools (`drizzle-kit`, `eslint`, `typescript`, `tailwindcss`).

---

## 4. Configure Neon PostgreSQL

1. Sign up at **neon.tech** (free tier) and create a project.
2. Copy the pooled connection string from the dashboard. It looks like:
   `postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require`
3. Keep it private — it will become `DATABASE_URL` in §9. **Never commit it.**
4. Notes:
   - The app uses the **`neon-http` serverless driver** (`src/lib/db/index.ts`); the connection string must be valid for Neon's HTTP endpoint.
   - `sslmode=require` is expected by the Neon URL format.
   - The database starts empty; the schema is applied by the Drizzle migration in §5. There is **no** seed data and **no** automatic fixture script.

---

## 5. Configure Drizzle migrations

The schema lives in `src/lib/db/schema/` with the generated migration committed at `drizzle/0000_chemical_killraven.sql` (it creates all tables: Better Auth's `user/session/account/verification`, `shipments`, `documents`, `extractions`, `extracted_fields`, `field_corrections`, `discrepancies`, `approvals`, `audit_logs`, plus all enums, indexes, composite FKs and CHECK constraints).

`drizzle.config.ts` loads `DATABASE_URL` from `.env.local` (first), then falls back to the ambient environment; it fails fast if neither is set.

Apply the committed migration to your (empty) Neon database:

```bash
npm run db:migrate    # runs drizzle-kit migrate using ./drizzle and DATABASE_URL
```

Optional commands (available, not required for setup):

```bash
npm run db:generate   # regenerates SQL migrations after schema/ changes
npm run db:studio     # Drizzle Studio: browse tables in a local web UI
```

> Do **not** modify database records by hand beyond the demo-account role update in §13. If `npm run db:migrate` reports that the schema is already up to date, nothing else is needed.

---

## 6. Configure Better Auth

No account is needed outside the app. Configuration is code + env:

- Server config: `src/lib/auth.ts` (Better Auth with a **Drizzle adapter**, email + password enabled).
- Route handler: `src/app/api/auth/[...all]/route.ts` mounts the Better Auth endpoints.
- Client helper: `src/lib/auth-client.ts`.
- Schema tables: `src/lib/db/schema/auth.ts` (`user`, `session`, `account`, `verification`).

Required environment configuration:

- `BETTER_AUTH_SECRET` — a **strong secret of at least 32 characters**. The app refuses to boot with a missing or short secret. Generate one:

  ```bash
  openssl rand -base64 32
  ```

- `BETTER_AUTH_URL` — the absolute origin of the app.

  - Local development: `http://localhost:3000`
  - (If you later deploy, this must match the deployed origin, e.g. `https://your-app.vercel.app` — see §12.)

Behavior notes (relevant to demo account creation in §13):

- Role is a server-owned extra field (`input: false`, default `DOCUMENTATION_EXECUTIVE`). Nobody can choose a role in the sign-up form, and **no API exists to change a role** — a manager is created with a one-row database update (§13).

---

## 7. Configure Cloudinary

Free Cloudinary account is used to store the uploaded PDFs as **private raw assets**.

1. Create a free account at **cloudinary.com**.
2. From the dashboard (Programmable Media → getting started), copy three values:
   - `CLOUDINARY_CLOUD_NAME`
   - `CLOUDINARY_API_KEY`
   - `CLOUDINARY_API_SECRET`
3. Place them in `.env.local` (§9). They are read **server-only** (`src/lib/storage/cloudinary.ts`); the validation messages name a missing variable but never echo the secret.

How the app uses Cloudinary (no configuration action required on your side):

- Uploads go out as `resource_type: "raw"`, `access_mode: "authenticated"`, `type: "authenticated"` (explicitly both flags, because `access_mode` alone is not a guarantee for raw/PDF delivery).
- Reads are **server-side signed requests**; no public or persisted URLs are ever created.
- Superseded document versions are **retained** (no asset deletion exists in the app); orphaned assets from a failed write are logged with key + checksum for reconciliation.
- A re-upload of the same content (same shipment + type + SHA-256) is rejected as a duplicate.

---

## 8. Configure Gemini

1. Get a free API key from **Google AI Studio** (aistudio.google.com) — no billing/payment card required for the free tier.
2. Set `GEMINI_API_KEY` in `.env.local` (§9). It is read **server-only** (`src/lib/ai/provider.ts`).
3. Recommended: restrict the key to the **Gemini API only** in the Google Cloud console key settings.

How the app uses Gemini (no configuration action on your side):

- Structured extraction through the **Files API** (PDF upload) + **Interactions API** (`model: gemini-3.5-flash-lite` with `generation_config: { thinking_level: "low" }`, Interactions API revision `2026-05-20`, per `src/lib/ai/provider.ts`), plain `fetch` adapter.
- Every interaction uses `store: false`; the uploaded file is deleted in a `finally` block right after the generation response is consumed (with a bounded polling window while the file state is not yet ACTIVE).
- The output schema is generated from the per-document extraction catalogs and validated strictly server-side before anything is persisted.
- A best-effort daily request ceiling (default **40/day**, `EXTRACTION_DAILY_REQUEST_CEILING` in `src/lib/ai/request-ceiling.ts`, plus a per-instance slot reservation) protects the free tier. It is honest best-effort, not a hard global cap; provider-side 429s remain the final guard.
- Opt-in connectivity probe: `POST /api/diagnostics/gemini` works only when `GEMINI_DIAGNOSTIC_ENABLED === "true"` (otherwise 404). Text-only, authenticated, never touches the DB or the extraction pipeline. The probe is pinned to a separate model, `gemini-3.8-flash` (`src/app/api/diagnostics/gemini/route.ts`) — it is a connectivity check only, **not** the production extraction model.

> **Data policy reminder:** the extraction adapter is designed for **synthetic documents only**. Do not send real customs documents.

---

## 9. Environment Variables (complete list)

All names below are referenced by the actual source code (verified against `src/lib/db/index.ts`, `src/lib/auth.ts`, `src/lib/storage/cloudinary.ts`, `src/lib/ai/provider.ts`, `src/app/api/diagnostics/*/route.ts`) and `drizzle.config.ts`. Copy `.env.example` → `.env.local` and set the values — **never commit real values, and do not print them anywhere.**

```dotenv
# Postgres (Neon) — used by the app AND by drizzle-kit (.env.local or ambient env)
DATABASE_URL="postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require"

# Better Auth
BETTER_AUTH_SECRET="..."      # min 32 chars, e.g. `openssl rand -base64 32`
BETTER_AUTH_URL="http://localhost:3000"

# Cloudinary — private raw PDF storage (server-side only; never NEXT_PUBLIC)
CLOUDINARY_CLOUD_NAME="..."
CLOUDINARY_API_KEY="..."
CLOUDINARY_API_SECRET="..."

# Gemini — server-side structured extraction (server-side only; never NEXT_PUBLIC)
GEMINI_API_KEY="..."

# Optional diagnostics (both default OFF; endpoints 404 unless enabled)
# GEMINI_DIAGNOSTIC_ENABLED="true"
# AUDIT_DIAGNOSTIC_ENABLED="true"
```

| Variable | Required? | Set by | Missing-name behavior |
| --- | --- | --- | --- |
| `DATABASE_URL` | Required | You | Fail-fast error at module load / drizzle-kit start |
| `BETTER_AUTH_SECRET` | Required (≥ 32 chars) | You | Fail-fast boot error |
| `BETTER_AUTH_URL` | Required (absolute URL) | You | Fail-fast boot error |
| `CLOUDINARY_CLOUD_NAME` | Required | You | Fail-fast error at storage-module load (upload fails) |
| `CLOUDINARY_API_KEY` | Required | You | Fail-fast error at storage-module load |
| `CLOUDINARY_API_SECRET` | Required | You | Fail-fast error at storage-module load (never echoed) |
| `GEMINI_API_KEY` | Required for extraction | You | Fail-fast error at provider-module load (never echoed) |
| `GEMINI_DIAGNOSTIC_ENABLED` | Optional | You | Diagnostics route answers 404 |
| `AUDIT_DIAGNOSTIC_ENABLED` | Optional | You | Audit-gap route answers 404 |

There are **no** `NEXT_PUBLIC_*` variables in this project. `NODE_ENV` is handled by Next.js itself; it is not an application setting.

---

## 10. Run locally

Verify the commands against `package.json` scripts (exact):

```text
dev      → next dev
build    → next build
start    → next start
lint     → eslint
db:generate → drizzle-kit generate
db:migrate  → drizzle-kit migrate
db:studio   → drizzle-kit studio
```

Steps:

```bash
# 1–3 done in §2–§3 (clone, npm install)
# 4  create .env.local with every required variable from §9
# 5  apply the migration once:
npm run db:migrate
# 6  start the dev server:
npm run dev
```

1. Open <http://localhost:3000>.
2. You should be redirected to `/sign-in`. Register the first user at `/sign-up` (any valid email + password ≥ 8 characters).
   The first user becomes a **DOCUMENTATION_EXECUTIVE** by design.
3. Follow §13 to create the manager demo account, then §14 for the demo workflow.

> The dev server must be restarted after any change to `.env.local` (Next.js caches process env at boot). Turbopack note: if a stale module seems cached, clear `.next` and restart `npm run dev`.

---

## 11. Build and production commands

Verified against `package.json`:

```bash
npm run lint    # ESLint 9 over the project
npm run build   # next build — production build (validates route types)
npm start       # next start — serves the production build
```

A production self-check used during development:

```bash
npx tsc --noEmit   # strict TypeScript check (no script alias needed)
```

Notes:

- `next.config.ts` enables `cacheComponents` and `partialPrefetching`; routes that read the session render dynamically by design (`instant = false` segments).
- `npm start` requires a completed `npm run build` and the same environment variables (it loads `.env.local` via the Next runtime; `drizzle.config.ts` also reads it for CLI tasks).

---

## 12. Vercel deployment — **NOT YET DEPLOYED**

> ⚠️ **Status: the application has NOT been deployed to Vercel. There is no live URL. The steps below are the prepared plan — none of them has been executed yet. Do not expect a working demo link.**

Prepared deployment steps (to execute after the submission review, if desired):

1. **Push** the final `master` to GitHub: <https://github.com/jaikishan1234/customsdoc-ai> (already public).
2. In the **Vercel** dashboard: *Add New → Project → Import* the `jaikishan1234/customsdoc-ai` repository (framework auto-detected as Next.js).
3. Add **environment variables** in *Project → Settings → Environment Variables* for Production (and Preview if wanted) — exactly the names from §9:
   - `DATABASE_URL`; `BETTER_AUTH_SECRET`; `BETTER_AUTH_URL`
   - `CLOUDINARY_CLOUD_NAME`; `CLOUDINARY_API_KEY`; `CLOUDINARY_API_SECRET`
   - `GEMINI_API_KEY`
   - Optionally the two diagnostic flags.
4. Set `BETTER_AUTH_URL` to the deployed origin (e.g. `https://customsdoc-ai.vercel.app`) and add that origin to Better Auth `trustedOrigins`. Currently `trustedOrigins` is derived from `BETTER_AUTH_URL` in `src/lib/auth.ts`, so setting the variable correctly is sufficient; verify sign-in works after the change.
5. **Database:** the existing Neon database is used as-is (Vercel functions reach it over the same HTTP driver). No additional Neon/Vercel integration step is required; migration is applied via `npm run db:migrate` from a machine with the proper `DATABASE_URL`, or via the Neon SQL console if `drizzle/0000_chemical_killraven.sql` has not been applied to the production database yet.
6. Deploy and watch the build summary for errors.
7. Post-deploy verification checklist:
   - `/sign-up`, `/sign-in` function (auth cookie is issued for the deployed origin);
   - shipping a synthetic document through upload → extraction → review → approval → export;
   - Cloudinary reveals signed downloads (no public URL); Gemini probe (if enabled) succeeds.
8. **Reviewer/demo credentials** would be created per §13 on the production database — not done yet; do not commit them anywhere.

---

## 13. Demo login accounts (Executive / Manager)

> **Placeholders — do not invent credentials.** Fill the tables below with the final demo account credentials before shipping the submission ZIP.

### Executive account

| Field | Value |
| --- | --- |
| Sign-up e-mail | `<!-- PLACEHOLDER: demo executive email -->` |
| Password | `<!-- PLACEHOLDER: demo executive password (do not print secrets in committed files) -->` |

Created **automatically** by signing up in the UI (`/sign-up`) — the default role is `DOCUMENTATION_EXECUTIVE`.

### Manager account

| Field | Value |
| --- | --- |
| Sign-up e-mail | `<!-- PLACEHOLDER: demo manager email -->` |
| Password | `<!-- PLACEHOLDER: demo manager password -->` |
| Role flip SQL | see below |

Because `user.role` is server-owned (`input: false`), no UI or API can grant the manager role. A **one-time database operation** is required:

1. Register the demo manager user in the UI (`/sign-up`) — it lands as an Executive temporarily.
2. Promote it with a single-row, single-column update in the **Neon SQL console** (or any SQL client with the connection string):

```sql
-- run on the target database; replaces exactly one account's role
UPDATE "user"
SET role = 'DOCUMENTATION_MANAGER'
WHERE email = '<demo manager email>';   -- REPLACE with the actual e-mail (placeholder)
```

3. Sign out and back in (the role is read server-side per session verification).
4. Optional sanity check: the top navigation shows the user's role; the manager sees Accept/Correct/Approve/Export controls that an executive does not.

> There is no CLI script, no service function and no HTTP endpoint that performs this update — it deliberately is a human, auditable step. Two users suffice for the demo: one Executive (uploads/extracts), one Manager (accepts, corrects, approves, exports).

---

## 14. Demo workflow with SHP-24811 and synthetic documents

The shipment **`SHP-24811`** was used to verify the entire workflow manually with **synthetic documents** (no real customs data). To reproduce it:

### Synthetic documents

Prepare three synthetic PDFs with coherent, fabricated data (≤ 25 MiB each, PDF):

| Document | Suggested synthetic content |
| --- | --- |
| Invoice | invoice number/date, seller, buyer, currency, total amount, etc. |
| Packing list | packing list number/date, total packages, **gross weight (kg)**, net weight, goods description |
| Bill of lading | B/L number/date, shipper, consignee, **gross weight (kg)** |

For a **discrepancy demo**, make the packing list and bill of lading gross weights **differ** (the verified example: 3,165 kg vs 3,120 kg — `WEIGHT_MISMATCH`, severity CRITICAL).

### Verified flow

1. **Sign in as the Executive** demo account (§13).
2. **Create shipment** `SHP-24811` under `/shipments/new` (reference format `SHP-[0-9]{4,10}`).
3. **Documents tab:** upload all three synthetic PDFs. Each file becomes an immutable version row with a SHA-256 checksum; the bill of lading and packing list references appear with their versions.
4. **Extraction & Review tab:** run extraction. The three documents process sequentially; each yields attempt rows and extracted fields with confidences and review states (required fields and low-confidence values require review).
5. **Field review (as Manager):** accept confirmed values; **correct** one value with a reason (verified case: packing list `gross_weight_kg` was corrected from the extracted value to the intended synthetic value — the correction row, audit entry (`FIELD_CORRECTED`) and re-run cross-check all reflect it; the discrepancy became **OBSOLETE** once the corrected values matched).
6. **Discrepancy path (before correction):** with the *original* mismatched synthetic weights, the cross-check created a live `WEIGHT_MISMATCH` row (OPEN, CRITICAL, expected/actual/delta evidence) that blocks the readiness panel and keeps the shipment from being approvable.
7. **Approval tab (as Manager):** after all fields are reviewed and no OPEN/RECHECK_PENDING discrepancy remains, readiness shows "Ready for approval"; approve — the decision stores the frozen evidence snapshot; the shipment status becomes `APPROVED`.
8. **Invalidation demo (optional):** replace any document, re-run extraction, or correct a field afterwards: the live approval flips to `INVALIDATED` (still visible in history), the shipment returns to `REVIEW`, and the reason + drift codes appear in the Activity tab. Re-approving afterwards works the same way.
9. **Export (as Manager):** Export section in the Approval tab — downloads `SHP-24811-export-<timestamp>.csv` (RFC-4180, CRLF, UTF-8; columns: `shipment_reference, document_type, document_version, field_key, field_label, value, unit, confidence, review_status`; one row per extracted field with effective corrected values). The shipment becomes **EXPORTED**; the Activity tab records `EXPORT_COMPLETED` with the row count.
10. Post-export: correction/acceptance/extraction/upload on that shipment are all correctly rejected.

This flow is **manually verified**; it is not scripted by any automated test (the repository has no test suite — see README §16 "Testing and Verification").

---

## 15. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Boot error: "`BETTER_AUTH_SECRET` is not set / too weak" | Missing or < 32-char secret | Generate with `openssl rand -base64 32`, set in `.env.local`, restart |
| Boot error: "`BETTER_AUTH_URL` is not set / invalid" | Missing or malformed origin (must be absolute `http(s)://…`) | Set `BETTER_AUTH_URL=http://localhost:3000` and restart |
| "`DATABASE_URL` is not set" (app boot or `drizzle-kit`) | Variable missing in `.env.local` (Drizzle Kit reads `.env.local`) or ambient env | Add it, restart the process |
| Upload fails immediately with a server 500 mentioning a Cloudinary variable | Cloudinary env not set/complete | Verify all three `CLOUDINARY_*` variables; restart; use the upload error's safe client message, not the log details |
| Extraction route returns 5xx mentioning a Gemini variable | `GEMINI_API_KEY` missing/invalid | Set it, restart; optionally enable `GEMINI_DIAGNOSTIC_ENABLED="true"` and `POST /api/diagnostics/gemini` (twice: it has a 15 s minimum probe interval) |
| Extraction returns `429`-ish / "rate limited" behavior | Free-tier Gemini quota or the best-effort daily ceiling (40/day) | Wait for the next UTC day; the ceiling is shared across the shipment's three documents per run |
| Upload 409 "duplicate" | The identical file (same SHA-256) is already the active version of that type | Re-upload the intended *changed* document; duplicates of the same content are refused by design |
| Extraction route returns 409 `status_blocked` | Shipment status outside `DRAFT/PROCESSING/REJECTED` (e.g. REVIEW/AWAITING_APPROVAL/APPROVED/EXPORTED) | Move the workflow state as intended (e.g. rejection returns a shipment to REJECTED, which is extraction-eligible again) |
| Import/extract fails with "attempt superseded" | A newer attempt exists for that document (max(attempt) law) | Review values of the current attempt; re-run extraction if needed |
| Missing option in the UI (no Accept/Correct/Approve/Export) | Signed in as Executive (role-based UI hiding) | Use the manager demo account (§13) |
| "role update could not change anything" (SQL §13 step 2) | Wrong e-mail literal / wrong database | Confirm the e-mail and that the SQL console is connected to the correct Neon project |
| CSV export blocked with "stale snapshot" | Evidence changed after the approval | The decision must be re-made; check the Activity tab for `APPROVAL_INVALIDATED` and re-approve when readiness passes again |
| CSV export 409 "already exported" | Export stamp is one-shot | The shipment is final; use a new shipment if data changes |
| Dev server weirdness after edits | Turbopack stale cache | Stop the dev server, delete `.next`, `npm run dev` again |
| Git shows `LF will be replaced by CRLF` warnings | Windows autocrlf conversion noise | Harmless; no action needed |

**Crash / data-state notes** (honest partial-failure windows on the transaction-less neon-http driver; all surfaced, never silent):

- A failed audit write on a persisted business write produces an explicit "audit missing" warning in the UI/response; find candidates later with `POST /api/diagnostics/audit-gaps` (opt-in via `AUDIT_DIAGNOSTIC_ENABLED`), then backfill **manually** (only `AUDIT_RECOVERED` provenance markers exist for that; there is no automatic backfill).
- A failed completion statement (S2) after a supersede (S1) leaves the document without a current completed attempt; recovery is simply running extraction again (the next attempt becomes current when it completes).
- An abandoned in-flight attempt (`PROCESSING` for longer than the stale age) is reaped to `FAILED/STALE_PROCESSING` with an audit entry on the next run.

---

## 16. What this guide deliberately does **not** claim

- No Vercel/production deployment (**§12 is a plan, not a record**).
- No automated tests (none exist in the repository).
- No reviewer credentials until you provide them (§13 placeholders).
- No secrets of any kind are included in this document; every value slot is a labelled placeholder for you to complete privately.
