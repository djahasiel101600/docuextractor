# DocuExtract

DocuExtract is a local application for extracting and reconciling fields from PDF documents in ZIP archives. It supports filename rules, native PDF text extraction, optional Tesseract OCR, field validation and diagnostics, manual review, PDF previews, and CSV exports.

## Technology

- **Frontend:** React 19, TypeScript, Vite 8, Tailwind CSS 4, shadcn-style UI components, React Router, TanStack Query, Axios, React Hook Form, and Zod.
- **Backend:** Python 3.13, Django 5.2, Django REST Framework, and drf-spectacular (OpenAPI/Swagger).
- **Database:** SQLite for local development; PostgreSQL 17 can be configured later.
- **Document processing:** Python, PyMuPDF, pytesseract, and Tesseract OCR.
- **Storage:** uploaded PDFs are kept under the persistent `storage/` directory.
- **Background jobs:** PDF extraction runs in a bounded local worker pool; Celery and Redis are not required.

## Prerequisites

- Windows 10/11 with PowerShell (commands below use PowerShell syntax).
- Python 3.13.
- Node.js 22 LTS and npm.
- Tesseract OCR installed if profiles use OCR fallback.

The local application uses a persistent SQLite database and does not require Docker or a separate database server.

## Installation

From the project root:

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r backend\requirements.txt
npm install
Copy-Item .env.example .env
```

If PowerShell prevents virtual-environment activation, run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` in that terminal and activate again.

Edit `.env` and replace the `DJANGO_SECRET_KEY` placeholder with a private random secret. The default `DATABASE_URL` uses a local SQLite file; PostgreSQL credentials are only needed if you choose to switch databases later. Do not commit `.env` or production credentials.

## Database setup

The SQLite database is stored at `storage/docuextract.sqlite3`. No database server or Docker setup is needed. Initialize or update the database schema with:

```powershell
npm run db:migrate
```

Migrations preserve existing records. The test command uses its own in-memory SQLite database and does not change the local development database.

PostgreSQL Compose configuration is retained for a future setup, but it is not required for local development. To switch later, configure `DATABASE_URL` in `.env`, start PostgreSQL, and migrate or explicitly transfer any data you need; changing the database URL alone does not copy data between databases.

To initialize a Django administrator account for `/admin/`:

```powershell
python backend\manage.py createsuperuser
```

There is no application sign-in feature in the original application. The Django admin remains protected by Django authentication; the application API is intended for local use and the development server binds to loopback.

## OCR setup

Install Tesseract OCR for your operating system:

- **Windows:** use the Windows installer linked from the [UB Mannheim Tesseract wiki](https://github.com/UB-Mannheim/tesseract/wiki).
- **macOS:** `brew install tesseract`
- **Debian/Ubuntu:** `sudo apt install tesseract-ocr`

If `tesseract.exe` is not on `PATH`, set `TESSERACT_CMD` in `.env`, for example:

```dotenv
TESSERACT_CMD=C:\Program Files\Tesseract-OCR\tesseract.exe
```

Set `OCR_ENABLED=false` to disable OCR. If OCR is enabled by a profile but Tesseract is unavailable, the job records the OCR failure in its diagnostics instead of silently substituting data.

Digitally generated PDFs use embedded text first. When OCR fallback is enabled, sparse-text pages are selected independently; with scan auto-detection enabled, image-heavy pages and pages associated with unresolved configured labels can also be OCRed. If configured fields remain missing and no suspect page is detected, the backend conservatively OCRs every page. Native and OCR candidates are retained and compared using a heuristic score based on label/layout confidence and configured validation; close conflicting scores are left unresolved for review. Scores are not calibrated probabilities. OCR rendering keeps its configured resolution and retains page coordinates for layout-aware matching.

`PDF_PROCESSING_WORKERS` controls the maximum number of PDFs extracted simultaneously. The default is 2 and the backend caps the value at 4 (and at available CPU cores) to limit CPU and memory use. Each document's timings for PDF loading, embedded text extraction, rendering, OCR, parsing, field extraction, database persistence, and total processing are stored with its result. The progress endpoint reports active filenames, elapsed time, average document time, and estimated remaining time.

Profiles also provide a label-match strictness control (default 82%). Raise it to reduce false label matches, or lower it to tolerate OCR errors; exact label matches are unaffected. For faint or small scanned text, choose High OCR Resolution in the profile editor to render at up to 3x scale, subject to the per-page pixel limit. Higher resolution uses more time and memory. Enter aliases on separate lines. If instructions are printed on the same line as a field label, include those instructions in the configured label so they are not mistaken for the extracted value.

## AI extraction with Ollama

Install and start [Ollama](https://ollama.com/) locally, then download a local model, for example:

```powershell
ollama pull llama3.2
```

In the profile editor, enable **AI (Ollama)**, enter `http://127.0.0.1:11434` and the model name, and use **Test Ollama Model**. The test checks model availability and performs a small structured generation, so a cold model load may take longer. Save the profile to apply the configuration to future jobs.

Choose **Cross-check every configured field**, **Review uncertain or conflicting candidates**, or **Fill missing fields only** to control which fields are sent to Ollama. Selective review uses a heuristic score threshold that has not been calibrated against a representative labeled corpus. The model receives page-preserving rows and approximate column positions. A candidate must have its label and value grounded in the same recognized source (native text or OCR) and pass layout checks; if usable layout is unavailable, the backend abstains. If the model cites layout coordinates instead of document text, the backend reconstructs evidence from that source's recognized text; layout metadata is never shown as evidence. Unsupported, blank, split-source, or cross-column candidates remain unresolved. AI does not correct OCR or invent missing values. Conventional extraction remains selected when candidates disagree; conflicts and AI-only values are flagged for review. Configure model context size and request timeout to match the configured model and document size.

Cloud-tagged models such as `beam:cloud` are supported when **Allow Ollama cloud models** is enabled in the profile. Cloud models send document text, field labels, and extraction context to Ollama's cloud service for processing. This opt-in defaults off; without it, the backend refuses cloud model requests before sending document content. Use a locally installed model if document data must remain on this machine. The app still connects only to a loopback Ollama URL; Ollama itself routes cloud-model requests to its cloud service. AI requests are serialized to limit simultaneous model use.

## Run locally

Activate `.venv` and make sure `.env` has a non-placeholder `DJANGO_SECRET_KEY`. The standard development command starts both the backend and frontend:

```powershell
npm run dev
```

`npm run dev:full` is an alias for the same command. To start the processes separately in two terminals:

```powershell
npm run backend:dev
npm run frontend:dev
```

- Frontend: <http://127.0.0.1:3000>
- Django REST API: <http://127.0.0.1:8000/api/>
- OpenAPI schema: <http://127.0.0.1:8000/api/schema/>
- Swagger UI: <http://127.0.0.1:8000/api/docs/>
- Django admin: <http://127.0.0.1:8000/admin/>

Vite proxies `/api` requests to Django. Upload preflight and ZIP handling occur in the browser, while document extraction, storage, job history, profile persistence, review changes, and CSV generation are handled by the backend API. ZIP processing returns a running job immediately; extraction proceeds in a bounded worker pool and the frontend polls for live progress.

## Tests and production build

```powershell
npm run lint
npm run test:backend
npm run build
```

`npm run test:backend` uses SQLite in memory and needs no PostgreSQL daemon or Tesseract executable. It tests profile CRUD, archive processing, nested PDF discovery, path traversal rejection, manual corrections, review status, file retrieval, and CSV export.

The production frontend output is written to `dist/`. `npm run preview` serves that build locally. Configure the production web server to route `/api/` to Django and keep uploaded PDFs on a persistent, non-public storage volume.

## Data locations and persistence

- Local development database: `storage/docuextract.sqlite3`.
- Optional PostgreSQL data: Docker's named `docuextract-postgres` volume.
- Uploaded and processed PDFs: `storage/jobs/`.
- Frontend build: `dist/` (generated).
- Environment secrets: `.env` (ignored by Git).

Deleting a processing job through the UI also deletes its stored PDF files. Restarting the app does not delete database rows or uploaded PDFs.

On first startup with an empty backend, existing browser-saved extraction profiles are copied into PostgreSQL. That migration leaves the original browser data untouched. Existing browser-only job history is not automatically imported; keep the old browser profile/storage data until any needed history has been exported.

## API overview

- `GET/POST /api/profiles/` and `GET/PUT/PATCH/DELETE /api/profiles/{id}/`
- `GET/POST /api/jobs/` (multipart ZIP upload and processing)
- `GET/DELETE /api/jobs/{id}/`
- `GET /api/jobs/{id}/export/?type=primary|diagnostics`
- `PATCH /api/documents/{id}/` (field correction or review status)
- `GET /api/documents/{id}/file/` (PDF preview)

Generated files are not served from a public static directory. The API only streams PDFs associated with known document records.

## Deploying to Ubuntu + Docker (Cloudflare Tunnel)

The production stack runs as three containers on a shared external Docker network named `jdp-network`:

| Service | Image | Role |
| --- | --- | --- |
| `db` | `postgres:17-alpine` | Primary database (private volume, never exposed). |
| `backend` | `Dockerfile.backend` | Django + DRF under Gunicorn; static files served with WhiteNoise. |
| `frontend` | `Dockerfile.frontend` | nginx serving the built SPA and reverse-proxying `/api`, `/admin`, `/static` to `backend`. |

This project exposes **no host ports**. Your Cloudflare Tunnel already runs on the host and is attached to `jdp-network`, so it reaches the app at `http://frontend:80` internally; nginx then serves the SPA and forwards API/admin traffic to the backend over the same network. Uploaded PDFs persist on the `docuextract-storage` volume and Postgres data on `docuextract-postgres`, so both survive restarts and redeploys.

### One-time server setup

```bash
# Clone the repo, then:
sudo bash scripts/deploy/setup-ubuntu.sh
```

The script installs Docker + the Compose plugin, creates `jdp-network` if it does not already exist, copies `.env.example` to `.env`, refuses to start until every placeholder secret is replaced, then builds and starts the stack and verifies the `/api` proxy from inside the frontend container (no port is opened on the host).

### Configuration

All runtime configuration is read from `.env` (git-ignored). Fill in `.env` following the comments in `.env.example`. The values that matter most for a correct, secure deployment:

- `DJANGO_DEBUG=false` and a strong `DJANGO_SECRET_KEY`.
- `DATABASE_URL=postgres://USER:PASSWORD@db:5432/DBNAME` (the `db` service name) and `DB_SSL_REQUIRE=false` (Postgres is reached on the private network, not over TLS).
- `DJANGO_ALLOWED_HOSTS` and `CORS_ALLOWED_ORIGINS` must both list the public origin (e.g. `https://app.example.com`). Because the browser sends an `Origin` header even for same-origin writes, `LocalApiOriginMiddleware` rejects the API if the public origin is missing from `CORS_ALLOWED_ORIGINS`.

### Cloudflare Tunnel

Your Cloudflare Tunnel already runs on this server and is joined to `jdp-network`, so nothing is added to the compose file for it. In the Cloudflare Zero Trust dashboard, add (or point) a **Public Hostname** on that existing tunnel to service `HTTP://frontend:80`. The name `frontend` resolves to this stack's container via `jdp-network`'s embedded DNS. No router/port forwarding is required — the tunnel is outbound-only and this project opens no host ports.

### Updating a deployment

```bash
git pull
sudo bash scripts/deploy/setup-ubuntu.sh --no-install   # rebuild changed images, restart, migrate on boot
```

Migrations run automatically on backend startup and preserve existing rows.

### Useful commands

```bash
docker compose ps                 # health of each service
docker compose logs -f backend    # extraction / API logs
docker compose exec backend python manage.py createsuperuser
```

See the [Security notes](#security-notes) below for hardening already applied (non-root backend, no published host ports, persistent volumes, health-gated startup order).

## Troubleshooting

- **Frontend cannot connect:** confirm `npm run backend:dev` is running and open `http://127.0.0.1:8000/api/` directly.
- **PostgreSQL connection refused:** start Docker Desktop, run `docker compose up -d db`, and confirm `.env` credentials match `DATABASE_URL`.
- **Missing Python dependencies:** activate `.venv` before running npm scripts that launch Django, then reinstall `backend\requirements.txt`.
- **Tesseract not found:** install it and set `TESSERACT_CMD` to the executable path.
- **Port already in use:** stop the process using port 3000 or 8000, or update the Vite/Django commands and `CORS_ALLOWED_ORIGINS` together.
- **Upload rejected:** check the ZIP size, uncompressed-size, file-count, PDF page-count, and file-signature limits configured in `.env`.

## Security notes

The local API accepts requests from the configured frontend origins and rejects requests carrying other browser origins. Django admin requires authentication. The API is designed to run on loopback for local development; do not expose it to a network or deploy it publicly without adding application authentication, HTTPS, and deployment-specific security settings.
