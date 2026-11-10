import logging
import os
import sys
import threading
import time

from django.apps import AppConfig
from django.conf import settings

logger = logging.getLogger(__name__)

# Management commands that must never start background workers. In particular
# `test` (no jobs should run against a test database), `migrate` (the schema
# may not exist yet) and the schema/introspection commands.
_SKIP_RECOVERY_COMMANDS = frozenset(
    {
        "test",
        "migrate",
        "makemigrations",
        "squashmigrations",
        "showmigrations",
        "collectstatic",
        "check",
        "shell",
        "shell_plus",
        "dbshell",
        "spectacular",
        "createsuperuser",
        "dumpdata",
        "loaddata",
        "flush",
        "sendtestemail",
    }
)


def _should_recover_jobs():
    if os.environ.get("DOCUEXTRACT_RECOVER_JOBS", "1") == "0":
        return False
    if any(command in sys.argv for command in _SKIP_RECOVERY_COMMANDS):
        return False
    # runserver's autoreloader starts two processes; only the child that
    # actually serves requests should recover jobs.
    if "runserver" in sys.argv and os.environ.get("RUN_MAIN") != "true":
        return False
    return True


def _job_recovery_loop():
    # Give migrations in the container entrypoint (and dev autoreload) a
    # moment before touching the schema.
    time.sleep(2)
    from .services.job_processing import recover_stale_jobs

    interval = max(int(settings.JOB_RECOVERY_INTERVAL_SECONDS), 5)
    while True:
        try:
            recover_stale_jobs()
        except Exception:  # noqa: BLE001 - never crash the server at boot
            logger.exception("Recovery scan for orphaned jobs failed.")
        # A worker can die at any point, not only while the process starts, so
        # the scan repeats. Every process runs it; the conditional-update claim
        # in recover_stale_jobs makes a duplicate resume impossible.
        time.sleep(interval)


class ExtractionConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "extraction"

    def ready(self):
        if not _should_recover_jobs():
            return
        threading.Thread(
            target=_job_recovery_loop,
            name="docuextract-job-recovery",
            daemon=True,
        ).start()
