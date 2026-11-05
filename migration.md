# Task: Migrate the Existing Gemini Vibe Coding Project into a Fully Standalone Local Development Environment

## 1. Project Objective

I have exported/downloaded this project from Google Gemini's Vibe Coding Platform and opened the project directory in Visual Studio Code.

I want to migrate the existing application into a fully standalone project that can be developed, modified, executed, and tested directly on my local machine through VS Code.

Currently, the application was designed to run within Gemini's Vibe Coding environment. My objective is to remove its dependency on that environment and make the application independently executable.

The VS Code AI Agent/Copilot must be able to:

- Understand the existing project architecture.
- Inspect and modify the application's source code.
- Install and manage project dependencies.
- Run the application locally.
- Execute backend and frontend processes.
- Run database migrations and initialize the database.
- Execute automated tests.
- Debug errors and inspect application logs.
- Implement new features and fix existing issues.
- Verify that changes work in the local environment.

**The ultimate goal is to make this project a conventional, independently maintainable software application rather than an application that can only execute inside Gemini's Vibe Coding Platform.**

## 2. Initial Project Assessment

Before making any modifications, thoroughly inspect the entire exported project.

Do not immediately rewrite the application or replace its existing technology stack.

Identify:

1. Frontend framework and build system.
2. Backend framework and application structure.
3. Programming languages and runtime requirements.
4. Existing dependencies and package managers.
5. Database technology and configuration.
6. Authentication and authorization mechanisms.
7. File upload and file storage implementation.
8. PDF parsing and text extraction libraries.
9. OCR implementation and dependencies.
10. AI/LLM integrations, if any.
11. Environment variables and configuration requirements.
12. Existing API endpoints and frontend/backend communication.
13. Existing test suites and testing infrastructure.
14. Platform-specific APIs, SDKs, services, or runtime dependencies originating from Gemini Vibe Coding.

Determine which parts of the application are standard, portable code and which parts depend on Gemini's hosted execution environment.

Provide an initial assessment identifying:

- What already works independently.
- What prevents local execution.
- What needs to be replaced or adapted.
- What dependencies are missing.
- What configuration changes are necessary.

Do not assume that all Gemini-specific integrations must be removed. Distinguish actual runtime dependencies from ordinary application code and third-party integrations.

## 3. Remove Gemini Vibe Coding Runtime Dependencies

Identify and replace platform-specific functionality that prevents the application from running independently.

Examples include, but are not limited to:

- Gemini-specific runtime APIs.
- Platform-managed backend execution.
- Hosted development environment dependencies.
- Platform-specific file handling.
- Platform-specific database integrations.
- Environment-provided secrets or configuration.
- Platform-specific authentication services.
- Proprietary frontend or backend SDKs that require the original execution environment.

Requirements:

- Replace platform-dependent functionality with conventional local implementations.
- Preserve existing business logic and application behavior.
- Maintain compatibility with existing frontend and backend interfaces where possible.
- Avoid introducing unnecessary dependencies.
- Do not remove useful functionality simply because it was originally implemented using a platform-specific service.
- If an external AI service is used, make its API integration configurable through environment variables rather than depending on Gemini's Vibe Coding runtime.

Where replacement is necessary, use maintainable and widely supported alternatives.

## 4. Local Development Environment

Configure the project to run locally from VS Code.

Requirements:

### A. Development Configuration

Provide all necessary configuration files and instructions to run the project locally.

Depending on the existing stack, this may include:

- Development environment variables.
- Frontend development configuration.
- Backend development configuration.
- Database configuration.
- Local file storage configuration.
- Dependency installation scripts.
- Development startup scripts.
- Database initialization and migration scripts.

Use `.env.example` to document all required environment variables.

Do not commit actual secrets, passwords, API keys, or credentials.

### B. Local Execution

The application must be executable through VS Code's integrated terminal.

Provide clear commands for:

1. Installing dependencies.
2. Configuring environment variables.
3. Initializing the database.
4. Running database migrations.
5. Creating an initial administrator account, if applicable.
6. Starting the backend.
7. Starting the frontend.
8. Running automated tests.
9. Building the production frontend.

If the frontend and backend require separate processes, document their respective startup commands.

Prefer providing convenient development scripts where appropriate.

### C. VS Code Integration

Where beneficial, configure:

- `.vscode/tasks.json` for common development commands.
- `.vscode/launch.json` for debugging.
- Recommended VS Code extensions.
- Workspace settings that improve development consistency.

Do not add unnecessary editor configuration.

## 5. Database and Persistent Storage

The application must use a locally accessible database during development.

First, inspect the existing database implementation.

Requirements:

- Preserve the existing database schema and business logic.
- Provide a working local database configuration.
- Ensure database migrations execute successfully.
- Ensure application data persists between restarts.
- Avoid using temporary in-memory storage for important application data.
- Document how to initialize and reset the development database.
- Preserve existing models for users, processing jobs, extraction profiles, PDF documents, extracted fields, diagnostics, and processing history, if present.

If the existing database can be used locally, retain it rather than unnecessarily migrating to another database.

For uploaded ZIP files, extracted PDFs, generated CSV files, and other application artifacts, configure a persistent local storage directory.

Ensure that uploaded files and generated outputs are not accidentally deleted when the application restarts.

## 6. PDF Processing and OCR Compatibility

Because this application processes ZIP archives containing PDF documents, verify that all document-processing functionality can execute locally.

Inspect and verify:

- ZIP archive extraction.
- Nested directory handling.
- PDF text extraction.
- OCR processing.
- Regex-based filename parsing.
- Context-aware data extraction.
- Document validation.
- Data reconciliation.
- CSV generation.
- PDF preview functionality.

Identify external system dependencies that may be required, such as OCR engines or other native libraries.

Document their installation requirements for the local operating system.

The application must not rely on Gemini's hosted filesystem or temporary file storage.

All document-processing operations must work with the configured local storage.

## 7. Dependency and Configuration Management

Review all dependencies and ensure they are compatible with the local development environment.

Requirements:

- Retain existing dependency versions when practical.
- Avoid unnecessary dependency upgrades.
- Identify missing packages and system-level dependencies.
- Generate or update the appropriate dependency manifests.
- Preserve lockfiles where applicable.
- Document required runtime versions.
- Avoid installing packages globally when project-level installation is appropriate.
- Separate development dependencies from production dependencies where supported.

Do not arbitrarily upgrade the entire project to the latest versions.

Prioritize compatibility and reproducibility.

## 8. Local Security and Configuration

Implement appropriate local development security practices.

Requirements:

- Keep credentials outside source code.
- Use environment variables for sensitive configuration.
- Configure appropriate local CORS settings.
- Protect administrative endpoints.
- Validate uploaded ZIP archives and PDF files.
- Prevent ZIP path traversal vulnerabilities.
- Apply reasonable upload size and processing limits.
- Keep generated files outside publicly accessible source directories unless intentionally served through authenticated endpoints.
- Ensure that local development settings are not automatically used in production.

Do not expose sensitive application data through unrestricted file-serving endpoints.

## 9. Automated Testing and Verification

After implementing the migration, actually execute the application and verify that it works.

Do not stop after generating configuration files or providing instructions.

At a minimum, test the following:

### Application Startup

- Dependencies install successfully.
- Database connection succeeds.
- Database migrations complete.
- Backend starts successfully.
- Frontend starts successfully.
- Frontend can communicate with the backend.

### Core Functionality

- User authentication works, if implemented.
- ZIP uploads work.
- PDF files are discovered correctly.
- Filename extraction works.
- PDF text extraction works.
- OCR fallback works when configured.
- Context-aware extraction functionality works.
- Extraction diagnostics are generated.
- CSV exports work.
- Processing history persists after restarting the application.

### Regression Testing

Ensure that the migration does not break existing application functionality.

Use the existing test suite where available and create additional tests for important migration-related functionality.

Report actual test results. Do not claim something passed if it was not executed.

## 10. Documentation

Create or update the project's root `README.md`.

It must include:

1. Project overview.
2. Technology stack.
3. Prerequisites.
4. Required software and runtime versions.
5. Installation instructions.
6. Environment configuration.
7. Database initialization.
8. Database migration commands.
9. Local development startup instructions.
10. Frontend and backend URLs.
11. Testing instructions.
12. Build instructions.
13. Local file storage locations.
14. Troubleshooting common errors.
15. Instructions for creating an administrator account, if applicable.

Make the instructions specific to the actual technology stack discovered in this project.

Do not provide generic commands that do not apply to the existing application.

## 11. Important Development Rules

Follow these instructions throughout the migration:

- Do not unnecessarily rebuild the application from scratch.
- Do not replace the existing framework without a compelling technical reason.
- Do not remove existing features.
- Do not replace working business logic with placeholder implementations.
- Do not introduce mock data as a substitute for actual functionality.
- Do not hardcode environment-specific paths or credentials.
- Do not assume Gemini's runtime capabilities are available locally.
- Do not leave incomplete integrations that make the application appear functional but fail during execution.
- Maintain existing application architecture wherever practical.
- Make incremental changes and verify each major modification.
- If a requirement cannot be implemented because of a missing external service or credential, clearly document the limitation rather than silently bypassing it.

When modifying existing files, inspect their current contents first and avoid overwriting unrelated functionality.

## 12. Final Deliverables

The completed project must contain:

- A locally executable frontend.
- A locally executable backend, if the architecture uses one.
- Working local database configuration.
- Persistent local file storage.
- Complete dependency manifests and lockfiles where applicable.
- `.env.example`.
- Updated `.gitignore`.
- VS Code development tasks and debugging configuration where appropriate.
- Working automated tests.
- Updated root `README.md`.
- No mandatory dependency on Gemini Vibe Coding's hosted execution environment.

## 13. Definition of Done

The migration is complete only when I can:

1. Open the exported project in VS Code.
2. Install its dependencies.
3. Configure its environment variables.
4. Initialize and migrate its local database.
5. Start the application using the documented local commands.
6. Access the application through my local browser.
7. Modify frontend and backend source code.
8. See changes reflected during local development.
9. Upload ZIP archives containing PDF documents.
10. Execute the document extraction workflow.
11. Generate and download CSV and diagnostics reports.
12. Run automated tests.
13. Stop and restart the application without losing persistent data.

**Final instruction:** Begin with a complete project audit. After identifying the necessary changes, implement the migration directly in the currently opened workspace. Do not merely explain how I could do it. Your responsibility is to modify the project, configure the local development environment, execute the necessary commands, run tests, troubleshoot encountered errors, and verify the final result.

# Additional Requirements: Mandatory Technology Stack and Application Architecture

## 1. Technology Stack

I want the existing application migrated and standardized using the following technology stack.

Do not choose alternative frameworks or replace the specified technologies unless a genuine technical limitation makes it necessary. If a limitation exists, explain it and request approval before changing the stack.

### Backend

- **Programming Language:** Python
- **Backend Framework:** Django
- **API Framework:** Django REST Framework (DRF)
- **Database:** PostgreSQL (preferred for production and local development)
- **Background Processing:** Celery with Redis, if required for asynchronous document processing
- **PDF Processing:** Python-based PDF extraction libraries
- **OCR:** Tesseract OCR or another suitable Python-compatible OCR solution
- **Data Processing:** Python libraries such as Pandas where appropriate
- **Validation:** Django serializers and Python validation utilities
- **API Documentation:** OpenAPI / Swagger documentation using a compatible DRF documentation package

The backend must use Django REST Framework to expose application functionality through properly structured REST APIs.

Take advantage of Python's ecosystem, particularly for:

- ZIP archive processing.
- PDF text extraction.
- OCR processing.
- Regex-based extraction.
- Context-aware document extraction.
- AI-assisted information extraction.
- Data validation and normalization.
- Data reconciliation.
- CSV generation.
- Batch processing.
- Extraction diagnostics and reporting.

Keep document-processing logic separate from Django views and serializers. Implement reusable Python services or modules so that extraction functionality can be independently tested and maintained.

### Frontend

- **Framework:** React
- **Programming Language:** TypeScript
- **Build Tool:** Vite
- **Styling:** Tailwind CSS
- **Component Library:** shadcn/ui
- **Icons:** Lucide React
- **Routing:** React Router
- **API Communication:** Axios or an equivalent well-maintained HTTP client
- **Server State Management:** TanStack Query (React Query)
- **Form Management:** React Hook Form
- **Schema Validation:** Zod

Use shadcn/ui as the primary component foundation.

Do not introduce another component library unnecessarily.

The frontend should communicate with Django REST Framework exclusively through documented API endpoints rather than directly accessing backend internals.

Use TypeScript strictly. Avoid excessive use of `any` and define reusable interfaces and types for API requests, responses, extraction profiles, processing jobs, documents, extracted fields, and diagnostics.

## 2. Recommended Project Structure

Organize the application using a clear separation between frontend and backend.

Use the following structure as a reference, adapting it to the existing project where appropriate:

```text
project-root/
│
├── frontend/
│   ├── public/
│   ├── src/
│   │   ├── components/
│   │   │   ├── ui/                 # shadcn/ui components
│   │   │   ├── layout/
│   │   │   └── shared/
│   │   │
│   │   ├── features/
│   │   │   ├── dashboard/
│   │   │   ├── processing/
│   │   │   ├── documents/
│   │   │   ├── extraction-profiles/
│   │   │   ├── diagnostics/
│   │   │   └── exports/
│   │

Before making any changes, show me the current project architecture and identify all dependencies on Gemini Vibe Coding. Then propose a migration plan based on the actual codebase.

Do not assume the project uses a particular framework or database. Inspect the existing files first.

You are authorized to modify the project files and execute necessary development commands within the opened workspace. However, do not delete existing project data, overwrite important configuration, or perform destructive database operations without asking me first.

Work incrementally. After each major implementation stage, run the relevant checks and resolve errors before proceeding.

```
