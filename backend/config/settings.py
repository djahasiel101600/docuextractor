import os
from pathlib import Path

import dj_database_url
from django.core.exceptions import ImproperlyConfigured
from django.core.management.utils import get_random_secret_key


BASE_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BASE_DIR.parent


def load_env_file() -> None:
    env_path = PROJECT_DIR / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


load_env_file()

DEBUG = os.getenv("DJANGO_DEBUG", "false").lower() == "true"
SECRET_KEY = os.getenv("DJANGO_SECRET_KEY")
if not SECRET_KEY:
    if not DEBUG:
        raise ImproperlyConfigured(
            "DJANGO_SECRET_KEY must be configured when DEBUG is false.")
    SECRET_KEY = get_random_secret_key()
ALLOWED_HOSTS = [
    host.strip()
    for host in os.getenv("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")
    if host.strip()
]

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "corsheaders",
    "rest_framework",
    "drf_spectacular",
    "extraction.apps.ExtractionConfig",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "extraction.middleware.LocalApiOriginMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

STORAGE_DIR = Path(os.getenv("DOCUEXTRACT_STORAGE_DIR",
                   str(PROJECT_DIR / "storage")))
if not STORAGE_DIR.is_absolute():
    STORAGE_DIR = PROJECT_DIR / STORAGE_DIR
MEDIA_ROOT = STORAGE_DIR

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    if not DEBUG:
        raise ImproperlyConfigured(
            "DATABASE_URL must be configured when DEBUG is false.")
    DATABASE_URL = f"sqlite:///{(STORAGE_DIR / 'docuextract.sqlite3').as_posix()}"

DATABASE_CONFIG = dj_database_url.parse(
    DATABASE_URL,
    conn_max_age=600,
    # TLS to the database is only needed when it is reached over an untrusted
    # network. On a private Docker network (e.g. jdp-network) set
    # DB_SSL_REQUIRE=false; when unset it defaults to the previous secure
    # behavior (required in production, off in debug).
    ssl_require=os.getenv("DB_SSL_REQUIRE", str(not DEBUG)).lower() == "true",
)
if DATABASE_CONFIG["ENGINE"] == "django.db.backends.sqlite3":
    DATABASE_CONFIG.setdefault("OPTIONS", {}).setdefault("timeout", 30)
    database_name = DATABASE_CONFIG["NAME"]
    if database_name != ":memory:" and not str(database_name).startswith("file:"):
        database_path = Path(database_name).expanduser()
        if not database_path.is_absolute():
            database_path = PROJECT_DIR / database_path
        database_path.parent.mkdir(parents=True, exist_ok=True)
        DATABASE_CONFIG["NAME"] = str(database_path)
DATABASES = {"default": DATABASE_CONFIG}

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
MEDIA_URL = "/media/"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# WhiteNoise serves the app's own static files (admin, drf-spectacular) from
# the collected STATIC_ROOT, so the backend image needs no separate static
# web server. Compressed (non-manifest) storage avoids 500s on references to
# files that were never collected. In DEBUG, finders are used directly.
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedStaticFilesStorage"},
}
WHITENOISE_USE_FINDERS = DEBUG
WHITENOISE_AUTOREFRESH = DEBUG

FRONTEND_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
    ).split(",")
    if origin.strip()
]
CORS_ALLOWED_ORIGINS = FRONTEND_ORIGINS
CSRF_TRUSTED_ORIGINS = FRONTEND_ORIGINS
CORS_URLS_REGEX = r"^/api/.*$"

# Production hardening. The stack terminates TLS at Cloudflare, so requests
# reach Django over the private Docker network as plain HTTP with the original
# scheme in X-Forwarded-Proto. CSRF/CORS rely on the public https origin being
# listed in CORS_ALLOWED_ORIGINS above.
if not DEBUG:
    USE_X_FORWARDED_HOST = os.getenv(
        "USE_X_FORWARDED_HOST", "true").lower() == "true"
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_CONTENT_TYPE_NOSNIFF = True
    SECURE_REFERRER_POLICY = "same-origin"
    # Cloudflare already enforces HTTPS; leave redirect off unless you want
    # Django to force it too (set SECURE_SSL_REDIRECT=true).
    SECURE_SSL_REDIRECT = os.getenv(
        "SECURE_SSL_REDIRECT", "false").lower() == "true"
    _hsts_seconds = int(os.getenv("SECURE_HSTS_SECONDS", "0"))
    if _hsts_seconds > 0:
        SECURE_HSTS_SECONDS = _hsts_seconds
        SECURE_HSTS_INCLUDE_SUBDOMAINS = os.getenv(
            "SECURE_HSTS_INCLUDE_SUBDOMAINS", "false").lower() == "true"
        SECURE_HSTS_PRELOAD = os.getenv(
            "SECURE_HSTS_PRELOAD", "false").lower() == "true"

REST_FRAMEWORK = {
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.AllowAny"],
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
}
SPECTACULAR_SETTINGS = {
    "TITLE": "DocuExtract API",
    "DESCRIPTION": "Local API for document processing, profiles, diagnostics, and exports.",
    "VERSION": "1.0.0",
    "SERVE_INCLUDE_SCHEMA": False,
}

MAX_UPLOAD_SIZE_BYTES = int(
    os.getenv("MAX_UPLOAD_SIZE_MB", "100")) * 1024 * 1024
MAX_ARCHIVE_UNCOMPRESSED_BYTES = int(
    os.getenv("MAX_ARCHIVE_UNCOMPRESSED_SIZE_MB", "500")
) * 1024 * 1024
MAX_ARCHIVE_FILES = int(os.getenv("MAX_ARCHIVE_FILES", "500"))
MAX_PDF_PAGES = int(os.getenv("MAX_PDF_PAGES", "500"))
PDF_PROCESSING_WORKERS = max(
    1,
    min(
        int(os.getenv("PDF_PROCESSING_WORKERS", "2")),
        4,
        os.cpu_count() or 1,
    ),
)
OCR_ENABLED = os.getenv("OCR_ENABLED", "true").lower() == "true"
TESSERACT_CMD = os.getenv("TESSERACT_CMD", "")
if TESSERACT_CMD:
    import pytesseract

    pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD

# --- OCR.space cloud OCR fallback (opt-in) -----------------------------------
# Offloads OCR to the free OCR.space API for CPU/RAM-constrained hosts. All
# values are read from the environment only; the API key is never hardcoded.
# Parsing is defensive so a malformed env value can never crash startup
# (fail-open: default to disabled / sane numeric defaults).
OCR_SPACE_ENABLED = os.getenv(
    "OCR_SPACE_ENABLED", "false").strip().lower() == "true"
OCR_SPACE_API_KEY = os.getenv("OCR_SPACE_API_KEY", "").strip()

try:
    OCR_SPACE_TIMEOUT_SECONDS = int(
        os.getenv("OCR_SPACE_TIMEOUT_SECONDS", "30"))
except (TypeError, ValueError):
    OCR_SPACE_TIMEOUT_SECONDS = 30
OCR_SPACE_TIMEOUT_SECONDS = max(1, min(OCR_SPACE_TIMEOUT_SECONDS, 300))

# Where OCR.space sits in the candidate pipeline. "after_ocr" (default) runs it
# only when local Tesseract failed or produced no/below-threshold text.
OCR_SPACE_PRIORITY = os.getenv(
    "OCR_SPACE_PRIORITY", "after_ocr").strip().lower()
if OCR_SPACE_PRIORITY not in ("after_ocr", "before_ocr", "override"):
    OCR_SPACE_PRIORITY = "after_ocr"
