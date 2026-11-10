/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
const DEBUG = import.meta.env.DEV; // or a feature flag

import React, { useState, useRef, useEffect, useMemo } from "react";
import {
  Upload,
  FileArchive,
  FileText,
  AlertCircle,
  Play,
  Sparkles,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  FileWarning,
  RefreshCw,
  Search,
  X,
  History,
  Gauge,
  Clock,
  LayoutTemplate,
} from "lucide-react";
import { ExtractionProfile, DocumentAssignment } from "../../types/extraction";
import {
  unpackZipArchive,
  unpackMultipleZipArchives,
  collectLoosePdfFiles,
  ArchiveDiscoveryResult,
  DiscoveredFileItem,
} from "../../services/zipService";
import { createDemoZipArchive } from "../../services/sampleArchiveGenerator";
import {
  assignJobProfiles,
  createBatchJob,
  getJobAssignments,
  uploadJobArchive,
  updateDocumentAssignment,
} from "../../services/apiClient";

interface JobSetupViewProps {
  profiles: ExtractionProfile[];
  selectedProfileId: string;
  onSelectProfileId: (id: string) => void;
  onStartProcessing: (
    archiveResult: ArchiveDiscoveryResult,
    profile: ExtractionProfile,
    existingJobId?: string,
  ) => void;
  isProcessing: boolean;
  processingProgress: {
    phase: "uploading" | "processing";
    total: number;
    completed: number;
    failed: number;
    skipped: number;
    currentFile: string;
    uploadPercent: number;
    remaining: number;
    currentFiles: string[];
    elapsedSeconds: number;
    averageSecondsPerDocument: number | null;
    estimatedRemainingSeconds: number | null;
    workerCount: number;
  } | null;
}

// ---------------------------------------------------------------------------
// Debug logging (Fix #7): every noisy [Debug] line is gated so nothing
// PII-adjacent runs in production builds.
// ---------------------------------------------------------------------------
function debugLog(...args: unknown[]): void {
  if (DEBUG) console.log(...args);
}

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------
function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "Calculating...";
  const totalSeconds = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

// Returns the lowercased extension of a filename (without the dot), or '' when
// there is none (e.g. dotfiles or names ending in a trailing dot).
function getExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0 || idx === filename.length - 1) return "";
  return filename.slice(idx + 1).toLowerCase();
}

// Human-readable byte size. Unsupported entries in the ZIP path may report 0
// when the archive header exposes no size, so fall back to a neutral label.
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "Unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Categories used to group unsupported non-PDF files for readability.
const UNSUPPORTED_CATEGORIES: { label: string; extensions: string[] }[] = [
  {
    label: "Images",
    extensions: [
      "jpg",
      "jpeg",
      "png",
      "gif",
      "bmp",
      "tif",
      "tiff",
      "webp",
      "heic",
      "heif",
      "svg",
    ],
  },
  {
    label: "Spreadsheets",
    extensions: ["xlsx", "xls", "xlsm", "xlsb", "csv", "tsv", "ods"],
  },
  {
    label: "Documents",
    extensions: ["doc", "docx", "rtf", "odt", "pages", "epub"],
  },
  { label: "Presentations", extensions: ["ppt", "pptx", "key", "odp"] },
  {
    label: "Text & data",
    extensions: ["txt", "md", "log", "json", "xml", "yaml", "yml"],
  },
  {
    label: "Archives",
    extensions: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"],
  },
  {
    label: "Audio & video",
    extensions: [
      "mp3",
      "wav",
      "m4a",
      "aac",
      "flac",
      "mp4",
      "mov",
      "avi",
      "mkv",
      "wmv",
    ],
  },
];

interface UnsupportedGroup {
  label: string;
  extensions: string[];
  items: DiscoveredFileItem[];
}

// Buckets unsupported files into known categories (by extension) and one
// "Other" bucket per unrecognized extension, so the panel reads naturally
// (e.g. "Spreadsheets (.xlsx): 3", "Other (.psd): 1").
function groupUnsupportedFiles(
  items: DiscoveredFileItem[],
): UnsupportedGroup[] {
  const extToCategory = new Map<string, string>();
  UNSUPPORTED_CATEGORIES.forEach((category) =>
    category.extensions.forEach((ext) =>
      extToCategory.set(ext, category.label),
    ),
  );

  const buckets = new Map<
    string,
    { label: string; order: number; items: DiscoveredFileItem[] }
  >();
  items.forEach((item) => {
    const ext = getExtension(item.filename);
    const categoryLabel = ext ? extToCategory.get(ext) : undefined;
    const key = categoryLabel ?? `other:${ext || "none"}`;
    const label = categoryLabel ?? "Other";
    const order = categoryLabel
      ? UNSUPPORTED_CATEGORIES.findIndex((c) => c.label === categoryLabel)
      : 1000 + (ext ? ext.charCodeAt(0) : 0);
    if (!buckets.has(key)) buckets.set(key, { label, order, items: [] });
    buckets.get(key)!.items.push(item);
  });

  return Array.from(buckets.values())
    .map((bucket) => ({
      label: bucket.label,
      extensions: Array.from(
        new Set(
          bucket.items
            .map((item) => getExtension(item.filename))
            .filter(Boolean),
        ),
      ).sort(),
      items: bucket.items,
      order: bucket.order,
    }))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

// --- Processing time estimation (tunable heuristic) ------------------------
const ESTIMATE_SECONDS_PER_DOC_PER_FIELD_MIN = 2;
const ESTIMATE_SECONDS_PER_DOC_PER_FIELD_MAX = 5;

// --- "Re-use last archive" cache -------------------------------------------
const ARCHIVE_CACHE_STORAGE_KEY = "docuextract.lastArchiveMeta";
const JOB_ID_STORAGE_KEY = "docuextract.currentJobId";

interface ArchiveCacheMeta {
  zipName: string;
  pdfCount: number;
  unsupportedCount: number;
  corruptedCount: number;
  totalBytes: number;
  savedAt: number;
}

// The full result (including binary PDF data + the source blob) is kept in a
// module-scoped variable so "Re-use last archive" restores instantly WITH
// working processing fidelity across Step 1/Step 2 remounts (tab switches).
// Blobs/ArrayBuffers cannot live in localStorage, so only a lightweight,
// JSON-safe summary is mirrored there for display. If the summary is found but
// the in-memory archive is gone (a hard refresh), the re-use affordance is
// dropped and the user simply uploads again - a graceful, non-crashing fallback.
let inMemoryArchiveCache: ArchiveDiscoveryResult | null = null;
// Module-level mirror of the current job id. Kept in sync with the component's
// jobIdRef via setJobId() so remounts (tab switches) preserve the job.
let inMemoryJobId: string | null = null;

function sumPdfBytes(result: ArchiveDiscoveryResult): number {
  return result.pdfFiles.reduce((sum, file) => sum + (file.sizeBytes || 0), 0);
}

function buildArchiveMeta(result: ArchiveDiscoveryResult): ArchiveCacheMeta {
  return {
    zipName: result.zipName,
    pdfCount: result.pdfFiles.length,
    unsupportedCount: result.unsupportedFiles.length,
    corruptedCount: result.corruptedFiles.length,
    totalBytes: sumPdfBytes(result),
    savedAt: Date.now(),
  };
}

function readArchiveMeta(): ArchiveCacheMeta | null {
  try {
    const raw = localStorage.getItem(ARCHIVE_CACHE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ArchiveCacheMeta) : null;
  } catch {
    return null;
  }
}

function writeArchiveMeta(meta: ArchiveCacheMeta): void {
  try {
    localStorage.setItem(ARCHIVE_CACHE_STORAGE_KEY, JSON.stringify(meta));
  } catch {
    // Quota exceeded or storage disabled (private mode): safe to ignore.
  }
}

function removeArchiveMeta(): void {
  try {
    localStorage.removeItem(ARCHIVE_CACHE_STORAGE_KEY);
    localStorage.removeItem(JOB_ID_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Fix #2 / #5: normalize an ArchiveDiscoveryResult into the list of archive
 * blobs that must be uploaded for the job. Preference order:
 *   1. `sourceArchives` if it has any entries (batch or single ZIP)
 *   2. fall back to `sourceFile` / `zipName` (legacy/single-file shape)
 *   3. empty list → caller throws a clear error
 *
 * Crucially this is *not* asymmetric like the old code: a single-entry
 * `sourceArchives` is still honored (previously it fell through to
 * `sourceFile`, which could be a different, repacked blob).
 */
function collectArchivesToUpload(
  result: ArchiveDiscoveryResult,
): Array<{ blob: Blob; filename: string }> {
  if (result.sourceArchives?.length) {
    return result.sourceArchives.map((a) => ({
      blob: a.blob,
      filename: a.filename,
    }));
  }
  if (result.sourceFile && result.zipName) {
    return [{ blob: result.sourceFile, filename: result.zipName }];
  }
  return [];
}

export const JobSetupView: React.FC<JobSetupViewProps> = ({
  profiles,
  selectedProfileId,
  onSelectProfileId,
  onStartProcessing,
  isProcessing,
  processingProgress: _processingProgress,
}) => {
  const [archiveResult, setArchiveResult] =
    useState<ArchiveDiscoveryResult | null>(null);
  const [isUnpacking, setIsUnpacking] = useState(false);
  const [unpackError, setUnpackError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Document Assignment state
  const [assignments, setAssignments] = useState<DocumentAssignment[]>([]);
  const [isAssigning, setIsAssigning] = useState(false);
  const [hasAnalyzed, setHasAnalyzed] = useState(false);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  // Profile the analysed batch job was created with. Frozen once analysed so a
  // later change to the global profile selection cannot misrepresent (or
  // silently replace) the job default the assignments were computed against.
  const [jobProfileId, setJobProfileId] = useState<string | null>(null);

  // Step 2 discovery UI state. The filename filter is purely visual: it never
  // mutates archiveResult.pdfFiles or excludes anything from processing.
  const [filenameFilter, setFilenameFilter] = useState("");
  const [debouncedFilter, setDebouncedFilter] = useState("");
  const [showUnsupported, setShowUnsupported] = useState(false);
  const [showInsights, setShowInsights] = useState(false);

  // "Re-use last archive" state. The full object lives in a module-scoped
  // cache (with binary data) for instant, processable restore; this component
  // state mirrors it for reactive UI.
  const [cachedArchive, setCachedArchive] =
    useState<ArchiveDiscoveryResult | null>(null);
  const [cachedArchiveMeta, setCachedArchiveMeta] =
    useState<ArchiveCacheMeta | null>(null);

  // Fix #1: component-scoped job id. Kept in sync with the module-level
  // `inMemoryJobId` (for remount persistence) via setJobId().
  const jobIdRef = useRef<string | null>(inMemoryJobId);

  // Fix #3: synchronous in-flight guard. State alone cannot prevent two clicks
  // in the same tick from both seeing `false`.
  const isAssigningRef = useRef(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Fix #2: single writer for the job id. Callers must use this instead of
  // assigning `inMemoryJobId` directly so the ref and module mirror never drift.
  const setJobId = (id: string | null) => {
    jobIdRef.current = id;
    inMemoryJobId = id;
  };

  // Debounce the applied filter ~200ms so fast typing does not thrash the list.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedFilter(filenameFilter), 200);
    return () => clearTimeout(handle);
  }, [filenameFilter]);

  // On mount, react to whatever survived in memory. A stale localStorage
  // summary from a previous page session (no binary in memory) is pruned so we
  // never offer a re-use that cannot actually be processed.
  useEffect(() => {
    if (inMemoryArchiveCache) {
      setCachedArchive(inMemoryArchiveCache);
      setCachedArchiveMeta(
        readArchiveMeta() ?? buildArchiveMeta(inMemoryArchiveCache),
      );
    } else {
      removeArchiveMeta();
    }
  }, []);

  // Fix #4: whenever the selected archive changes, forget the previous job so
  // the next "Analyze" creates a fresh one and uploads the new file(s).
  // This centralizes the reset that used to be duplicated across handlers.
  useEffect(() => {
    setJobId(null);
    setHasAnalyzed(false);
    setAssignments([]);
    setAssignmentError(null);
    setJobProfileId(null);
  }, [archiveResult]);

  const resetDiscoveryViews = () => {
    setFilenameFilter("");
    setDebouncedFilter("");
    setShowUnsupported(false);
    setShowInsights(false);
  };

  const rememberArchive = (result: ArchiveDiscoveryResult) => {
    inMemoryArchiveCache = result;
    const meta = buildArchiveMeta(result);
    writeArchiveMeta(meta);
    setCachedArchive(result);
    setCachedArchiveMeta(meta);
  };

  const handleReuseArchive = () => {
    if (!inMemoryArchiveCache) {
      removeArchiveMeta();
      setCachedArchive(null);
      setCachedArchiveMeta(null);
      setUnpackError(
        "The previous archive is no longer available in this browser session. Please upload it again.",
      );
      return;
    }
    resetDiscoveryViews();
    // Setting archiveResult triggers the reset useEffect above.
    setArchiveResult(inMemoryArchiveCache);
  };

  const totalPdfCount = archiveResult?.pdfFiles.length ?? 0;

  const visiblePdfFiles = useMemo(() => {
    const pdfs = archiveResult?.pdfFiles ?? [];
    const query = debouncedFilter.trim().toLowerCase();
    if (!query) return pdfs;
    return pdfs.filter((file) => file.filename.toLowerCase().includes(query));
  }, [archiveResult, debouncedFilter]);

  const unsupportedGroups = useMemo(
    () => groupUnsupportedFiles(archiveResult?.unsupportedFiles ?? []),
    [archiveResult],
  );

  const activeProfile =
    profiles.find((p) => p.id === selectedProfileId) || profiles[0];

  // The profile the analysed job is actually bound to. Before analysis this is
  // simply the current selection; afterwards it is frozen to the profile the
  // backend job was created with, so nothing in this step can diverge from the
  // assignments the user just reviewed.
  const jobProfile =
    (hasAnalyzed && profiles.find((p) => p.id === jobProfileId)) || activeProfile;

  // Aggregate metrics + processing estimate for the Insights panel, computed
  // entirely client-side from archiveResult (no network). Based on ALL PDFs in
  // the archive, not the visually-filtered subset, since every PDF is processed.
  const archiveStats = useMemo(() => {
    const pdfs = archiveResult?.pdfFiles ?? [];
    const count = pdfs.length;
    let total = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    pdfs.forEach((file) => {
      const size = file.sizeBytes || 0;
      total += size;
      if (size < min) min = size;
      if (size > max) max = size;
    });
    const fieldCount = activeProfile?.fields.length ?? 0;
    return {
      count,
      total,
      avg: count ? Math.round(total / count) : 0,
      min: count ? min : 0,
      max,
      fieldCount,
      minSeconds: count * fieldCount * ESTIMATE_SECONDS_PER_DOC_PER_FIELD_MIN,
      maxSeconds: count * fieldCount * ESTIMATE_SECONDS_PER_DOC_PER_FIELD_MAX,
    };
  }, [archiveResult, activeProfile]);

  // Handle uploaded files (ZIP or loose PDFs)
  const handleFiles = async (files: FileList | File[]) => {
    if (!files || files.length === 0) return;
    setIsUnpacking(true);
    setUnpackError(null);

    try {
      const fileArray = Array.from(files);
      const zipFiles = fileArray.filter((file) =>
        file.name.toLowerCase().endsWith(".zip"),
      );

      let result: ArchiveDiscoveryResult;
      if (zipFiles.length > 1) {
        result = await unpackMultipleZipArchives(zipFiles);
      } else if (zipFiles.length === 1) {
        result = await unpackZipArchive(zipFiles[0], zipFiles[0].name);
      } else {
        // collectLoosePdfFiles filters non-PDF entries internally, so passing
        // the raw dropped files (which bypass `accept`) is safe here.
        result = await collectLoosePdfFiles(fileArray);
      }
      resetDiscoveryViews();
      // Setting archiveResult triggers the reset useEffect above.
      setArchiveResult(result);
      rememberArchive(result);
    } catch (err: unknown) {
      setUnpackError(
        err instanceof Error ? err.message : "Failed to read uploaded archive",
      );
    } finally {
      setIsUnpacking(false);
    }
  };

  // Generate and load synthetic demo archive
  const handleLoadDemoArchive = async () => {
    setIsUnpacking(true);
    setUnpackError(null);

    try {
      const demoBlob = await createDemoZipArchive();
      const result = await unpackZipArchive(
        demoBlob,
        "batch_2026_q1_civil_forms.zip",
      );
      resetDiscoveryViews();
      setArchiveResult(result);
      rememberArchive(result);
    } catch (err: unknown) {
      setUnpackError(
        err instanceof Error ? err.message : "Failed to generate demo archive",
      );
    } finally {
      setIsUnpacking(false);
    }
  };

  const handleStart = () => {
    if (!archiveResult || !jobProfile || archiveResult.pdfFiles.length === 0)
      return;
    // Fix #2: read the unified source of truth.
    onStartProcessing(
      archiveResult,
      jobProfile,
      jobIdRef.current ?? undefined,
    );
  };

  const handleAnalyzeDocuments = async () => {
    if (!archiveResult || !activeProfile) return;

    // Fix #3: synchronous in-flight guard.
    if (isAssigningRef.current) return;
    isAssigningRef.current = true;

    setIsAssigning(true);
    setAssignmentError(null);

    try {
      let jobId = jobIdRef.current;

      if (!jobId) {
        debugLog("[Debug] JobSetupView: createBatchJob payload", {
          endpoint: "POST /api/jobs/batch/",
          body: { profileId: activeProfile.id },
        });
        const job = await createBatchJob(activeProfile.id);
        jobId = job.id;
        setJobId(jobId);
        setJobProfileId(activeProfile.id);
        debugLog("[Debug] JobSetupView: createBatchJob response", {
          jobId: job.id,
          status: job.status,
          totalDiscovered: job.totalDiscovered,
        });

        const archives = collectArchivesToUpload(archiveResult);
        if (archives.length === 0) {
          throw new Error("No archive file available to upload.");
        }

        for (const archive of archives) {
          debugLog("[Debug] JobSetupView: uploadJobArchive payload", {
            endpoint: `POST /api/jobs/${jobId}/archives/`,
            body: {
              fieldName: "file",
              filename: archive.filename,
              sizeBytes: archive.blob.size,
              type: archive.blob.type,
              jobId,
            },
            note: "multipart/form-data - binary blob not logged for brevity",
          });
          await uploadJobArchive(jobId, archive.blob, archive.filename);
        }
      }

      debugLog("[Debug] JobSetupView: assignJobProfiles payload", {
        endpoint: `POST /api/jobs/${jobId}/assign/`,
        body: null,
        note: "Empty POST body - backend reads only job_id from URL",
      });
      await assignJobProfiles(jobId);

      debugLog("[Debug] JobSetupView: getJobAssignments payload", {
        endpoint: `GET /api/jobs/${jobId}/assignments/`,
        body: null,
        note: "GET request - no body",
      });
      const results = await getJobAssignments(jobId);

      debugLog("[Debug] JobSetupView: getJobAssignments response", {
        count: results.length,
        // Fix #6: do not log filenames/PII. Use fields that are safe to emit.
        sample: results.slice(0, 5).map((r) => ({
          id: r.id,
          profileId: r.profileId,
          status: r.assignmentStatus,
        })),
      });

      setAssignments(results);
      setHasAnalyzed(true);
    } catch (err: unknown) {
      setAssignmentError(
        err instanceof Error ? err.message : "Failed to analyze documents",
      );
    } finally {
      isAssigningRef.current = false;
      setIsAssigning(false);
    }
  };

  const handleUpdateAssignment = async (
    docId: string,
    update: { profileId?: string | null; assignmentStatus?: string },
  ) => {
    try {
      // Fix #2: unified source of truth.
      const jobId = jobIdRef.current;
      if (!jobId) {
        setAssignmentError(
          "No job has been created yet. Please analyze documents first.",
        );
        return;
      }
      await updateDocumentAssignment(docId, update);
      const results = await getJobAssignments(jobId);
      setAssignments(results);
    } catch (err: unknown) {
      setAssignmentError(
        err instanceof Error ? err.message : "Failed to update assignment",
      );
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      {/* View Title */}
      <div>
        <h2 className="text-xl font-bold text-neutral-900 tracking-tight">
          New Document Processing Job
        </h2>
        <p className="text-xs text-neutral-500 mt-1">
          Upload a ZIP archive containing multiple digital PDF forms or test
          with our sample archive.
        </p>
      </div>

      {/* Step 1: Upload Archive Box */}
      <div className="bg-white rounded-xl border border-neutral-200 p-6 shadow-xs space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-neutral-900 text-white text-xs font-bold flex items-center justify-center">
              1
            </span>
            <h3 className="text-sm font-bold text-neutral-900">
              Select or Drop ZIP Archive
            </h3>
          </div>

          <div className="flex items-center gap-2">
            {cachedArchive && (
              <button
                type="button"
                onClick={handleReuseArchive}
                disabled={isUnpacking || isProcessing}
                title={
                  cachedArchiveMeta
                    ? `${cachedArchiveMeta.zipName} · ${cachedArchiveMeta.pdfCount} PDFs`
                    : "Re-use the last discovered archive"
                }
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-neutral-800 bg-white hover:bg-neutral-100 rounded-md transition-colors border border-neutral-300"
              >
                <History className="w-3.5 h-3.5 text-neutral-600" />
                <span>Re-use last archive</span>
              </button>
            )}
            <button
              type="button"
              onClick={handleLoadDemoArchive}
              disabled={isUnpacking || isProcessing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-neutral-800 bg-neutral-100 hover:bg-neutral-200 rounded-md transition-colors border border-neutral-200"
            >
              <Sparkles className="w-3.5 h-3.5 text-neutral-700" />
              <span>Load Realistic Demo Archive (8 PDFs)</span>
            </button>
          </div>
        </div>

        {/* Drag and Drop Dropzone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
          }}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${isDragging
              ? "border-neutral-900 bg-neutral-50"
              : "border-neutral-300 hover:border-neutral-400 bg-neutral-50/50"
            }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,.pdf"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) handleFiles(e.target.files);
            }}
          />

          <div className="max-w-md mx-auto space-y-3">
            <div className="w-12 h-12 rounded-full bg-neutral-100 text-neutral-700 flex items-center justify-center mx-auto">
              {isUnpacking ? (
                <RefreshCw className="w-6 h-6 animate-spin text-neutral-900" />
              ) : (
                <Upload className="w-6 h-6 text-neutral-700" />
              )}
            </div>
            <div>
              <p className="text-sm font-semibold text-neutral-900">
                {isUnpacking
                  ? "Reading & unpacking archive contents..."
                  : "Click to browse or drop ZIP archive here"}
              </p>
              <p className="text-xs text-neutral-500 mt-1">
                Supports nested directories, folder structures, multiple loose
                .pdf files, or several ZIP archives at once (batch upload).
              </p>
            </div>
          </div>
        </div>

        {unpackError && (
          <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
            <span>{unpackError}</span>
          </div>
        )}
      </div>

      {/* Step 2: Discover Documents */}
      {archiveResult && (
        <div className="bg-white rounded-xl border border-neutral-200 p-6 shadow-xs space-y-5 animate-in fade-in">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-neutral-900 text-white text-xs font-bold flex items-center justify-center">
                2
              </span>
              <div>
                <h3 className="text-sm font-bold text-neutral-900">
                  Discover Documents ({archiveResult.pdfFiles.length} PDFs)
                </h3>
                <p className="text-xs text-neutral-500 font-mono">
                  {archiveResult.sourceArchives &&
                    archiveResult.sourceArchives.length > 1
                    ? `Batch: ${archiveResult.sourceArchives.length} archives · ${Math.round(archiveResult.zipSizeBytes / 1024)} KB total`
                    : `Archive: ${archiveResult.zipName} · ${Math.round(archiveResult.zipSizeBytes / 1024)} KB total`}
                </p>
              </div>
            </div>
          </div>

          {/* Filename filter (visual only) */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 text-neutral-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={filenameFilter}
                onChange={(e) => setFilenameFilter(e.target.value)}
                placeholder="Filter filenames by substring (e.g. _w8) — hides rows only, all PDFs are still processed"
                aria-label="Filter discovered PDFs by filename"
                className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-neutral-300 rounded-md focus:outline-hidden focus:ring-2 focus:ring-neutral-900"
              />
            </div>
            <span className="text-[11px] text-neutral-500 tabular-nums whitespace-nowrap shrink-0">
              Showing {visiblePdfFiles.length} of {totalPdfCount} PDFs
            </span>
            {filenameFilter && (
              <button
                type="button"
                onClick={() => setFilenameFilter("")}
                className="flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-neutral-600 hover:text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-md transition-colors shrink-0"
                aria-label="Clear filename filter"
              >
                <X className="w-3 h-3" />
                <span>Reset</span>
              </button>
            )}
          </div>

          {/* Discovered files list preview (filtered view) */}
          <div className="border border-neutral-200 rounded-lg overflow-hidden max-h-56 overflow-y-auto divide-y divide-neutral-100 text-xs">
            {visiblePdfFiles.length === 0 ? (
              <div className="p-6 text-center text-neutral-400">
                No PDFs match &quot;{debouncedFilter}&quot;.
              </div>
            ) : (
              visiblePdfFiles.map((file) => (
                <div
                  key={file.id}
                  className="p-2.5 px-4 flex items-center justify-between hover:bg-neutral-50"
                >
                  <div className="flex items-center gap-2.5 truncate">
                    <FileText className="w-4 h-4 text-neutral-500 shrink-0" />
                    <span className="font-medium text-neutral-900 truncate">
                      {file.filename}
                    </span>
                    <span className="text-neutral-400 font-mono text-[11px] truncate">
                      ({file.relativePath})
                    </span>
                    {file.archiveName && (
                      <span
                        className="text-[10px] font-semibold text-neutral-600 bg-neutral-100 border border-neutral-200 rounded px-1.5 py-0.5 truncate max-w-40 shrink-0"
                        title={`From archive: ${file.archiveName}`}
                      >
                        {file.archiveName}
                      </span>
                    )}
                  </div>
                  <span className="text-neutral-400 font-mono text-[11px] shrink-0 tabular-nums">
                    {Math.round(file.sizeBytes / 1024)} KB
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Processing Insights */}
          <div className="border border-neutral-200 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setShowInsights((prev) => !prev)}
              className="w-full flex items-center justify-between p-3 bg-neutral-50 hover:bg-neutral-100 transition-colors"
              aria-expanded={showInsights}
            >
              <span className="flex items-center gap-2 text-xs font-semibold text-neutral-800">
                {showInsights ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
                <Gauge className="w-4 h-4 text-neutral-600" />
                <span>Processing Insights</span>
              </span>
              <span className="flex items-center gap-2 text-[11px] text-neutral-500">
                <span className="tabular-nums">{archiveStats.count} PDFs</span>
                <span aria-hidden>&middot;</span>
                <span className="tabular-nums">
                  {formatBytes(archiveStats.total)}
                </span>
                {archiveResult.unsupportedFiles.length > 0 && (
                  <>
                    <span aria-hidden>&middot;</span>
                    <span className="text-amber-700 tabular-nums">
                      {archiveResult.unsupportedFiles.length} ignored
                    </span>
                  </>
                )}
              </span>
            </button>

            {showInsights && (
              <div className="p-3 border-t border-neutral-200 bg-white space-y-4 text-xs animate-in fade-in">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div className="p-2.5 rounded border border-neutral-200 bg-neutral-50">
                    <div className="text-[10px] uppercase tracking-wide text-neutral-500">
                      Total PDFs
                    </div>
                    <div className="text-sm font-bold text-neutral-900 tabular-nums">
                      {archiveStats.count}
                    </div>
                  </div>
                  <div className="p-2.5 rounded border border-neutral-200 bg-neutral-50">
                    <div className="text-[10px] uppercase tracking-wide text-neutral-500">
                      Total Size
                    </div>
                    <div className="text-sm font-bold text-neutral-900 tabular-nums">
                      {formatBytes(archiveStats.total)}
                    </div>
                  </div>
                  <div className="p-2.5 rounded border border-neutral-200 bg-neutral-50">
                    <div className="text-[10px] uppercase tracking-wide text-neutral-500">
                      Avg File Size
                    </div>
                    <div className="text-sm font-bold text-neutral-900 tabular-nums">
                      {formatBytes(archiveStats.avg)}
                    </div>
                  </div>
                  <div className="p-2.5 rounded border border-neutral-200 bg-neutral-50">
                    <div className="text-[10px] uppercase tracking-wide text-neutral-500">
                      Size Range
                    </div>
                    <div className="text-[11px] font-semibold text-neutral-900 tabular-nums">
                      {archiveStats.count > 0
                        ? `${formatBytes(archiveStats.min)} \u2013 ${formatBytes(archiveStats.max)}`
                        : "N/A"}
                    </div>
                  </div>
                </div>

                <div className="flex items-start gap-2 p-2.5 rounded border border-neutral-200 bg-neutral-50">
                  <Clock className="w-4 h-4 text-neutral-500 shrink-0 mt-0.5" />
                  <div className="text-neutral-700">
                    {archiveStats.count === 0 ? (
                      <span>No PDFs to process.</span>
                    ) : (
                      <>
                        <span className="font-semibold text-neutral-900">
                          Estimated processing: ~
                          {formatDuration(archiveStats.minSeconds)}&ndash;
                          {formatDuration(archiveStats.maxSeconds)}
                        </span>{" "}
                        for {archiveStats.count}{" "}
                        {archiveStats.count === 1 ? "PDF" : "PDFs"} with{" "}
                        {archiveStats.fieldCount}{" "}
                        {archiveStats.fieldCount === 1 ? "field" : "fields"}
                        {archiveStats.count > 50 ? " (rough estimate)" : ""}.
                      </>
                    )}
                  </div>
                </div>

                {archiveResult.unsupportedFiles.length > 0 && (
                  <div className="border border-amber-200 rounded-lg overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setShowUnsupported((prev) => !prev)}
                      className="w-full flex items-center justify-between p-2.5 bg-amber-50/60 hover:bg-amber-50 transition-colors"
                      aria-expanded={showUnsupported}
                    >
                      <span className="flex items-center gap-2 text-xs font-semibold text-amber-800">
                        {showUnsupported ? (
                          <ChevronDown className="w-4 h-4" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                        <FileWarning className="w-4 h-4 text-amber-600" />
                        <span>Review Unsupported Files</span>
                        <span className="text-[11px] font-normal text-amber-700 bg-amber-100 border border-amber-200 rounded px-1.5 py-0.5">
                          {archiveResult.unsupportedFiles.length} ignored
                        </span>
                      </span>
                    </button>

                    {showUnsupported && (
                      <div className="p-3 border-t border-amber-200 bg-neutral-50 space-y-3 animate-in fade-in">
                        <p className="text-neutral-600 leading-relaxed">
                          These files were skipped because they are not PDFs.
                          DocuExtractor only processes PDF documents &mdash;
                          other formats cannot be parsed for form-field
                          extraction, so they are ignored and not added to this
                          job.
                        </p>

                        {unsupportedGroups.map((group) => (
                          <div
                            key={`${group.label}:${group.extensions.join(",")}`}
                            className="space-y-1"
                          >
                            <div className="font-semibold text-neutral-800">
                              {group.extensions.length > 0
                                ? `${group.label} (${group.extensions.map((ext) => `.${ext}`).join(", ")})`
                                : group.label}
                              {`: ${group.items.length}`}
                            </div>
                            <div className="rounded border border-neutral-200 bg-white divide-y divide-neutral-100">
                              {group.items.map((item) => {
                                const ext = getExtension(item.filename);
                                return (
                                  <div
                                    key={item.id}
                                    className="p-2 px-3 flex items-center justify-between gap-3"
                                  >
                                    <div className="flex items-center gap-2 min-w-0">
                                      <FileArchive className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                                      <span className="font-medium text-neutral-900 truncate">
                                        {item.filename}
                                      </span>
                                      <span className="text-neutral-400 font-mono text-[11px] truncate">
                                        ({item.relativePath})
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-3 shrink-0">
                                      <span className="text-[10px] font-mono text-neutral-600 bg-neutral-100 border border-neutral-200 rounded px-1.5 py-0.5">
                                        {ext ? `.${ext}` : "no ext"}
                                      </span>
                                      <span className="text-neutral-400 font-mono text-[11px] tabular-nums">
                                        {formatBytes(item.sizeBytes)}
                                      </span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Step 3: Document Assignment Review */}
      {archiveResult && (
        <div className="bg-white rounded-xl border border-neutral-200 p-6 shadow-xs space-y-5 animate-in fade-in">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-neutral-900 text-white text-xs font-bold flex items-center justify-center">
                3
              </span>
              <div>
                <h3 className="text-sm font-bold text-neutral-900">
                  Review Document Assignments
                </h3>
                <p className="text-xs text-neutral-500">
                  Review auto-assigned profiles and manually override
                  assignments if needed.
                </p>
              </div>
            </div>

            {!hasAnalyzed && (
              <button
                type="button"
                onClick={handleAnalyzeDocuments}
                disabled={isAssigning}
                className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-white bg-neutral-900 hover:bg-neutral-800 rounded-md transition-colors disabled:opacity-50"
              >
                {isAssigning ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" />
                )}
                <span>
                  {isAssigning ? "Analyzing..." : "Analyze Documents"}
                </span>
              </button>
            )}
          </div>

          {/* Job default extraction profile. The batch job is created with it,
              and it is the fallback for documents without their own match. It
              is frozen once analysed so the reviewed assignments stay valid. */}
          {!hasAnalyzed ? (
            <div className="flex flex-wrap items-center gap-3 p-3 rounded-lg border border-neutral-200 bg-neutral-50">
              <label
                htmlFor="job-default-profile"
                className="flex items-center gap-1.5 text-xs font-semibold text-neutral-800"
              >
                <LayoutTemplate className="w-4 h-4 text-neutral-600" />
                <span>Default extraction profile</span>
              </label>
              <select
                id="job-default-profile"
                value={activeProfile?.id ?? ""}
                onChange={(e) => onSelectProfileId(e.target.value)}
                disabled={isAssigning || isProcessing || profiles.length === 0}
                className="px-2 py-1 text-xs bg-white border border-neutral-300 rounded-md focus:outline-hidden focus:ring-2 focus:ring-neutral-900 disabled:opacity-50"
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-neutral-500 leading-relaxed">
                Applied to documents without a profile match. Every file can
                still be overridden in the table below; unmatched documents are
                reported instead of being processed with this profile.
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 p-3 rounded-lg border border-neutral-200 bg-neutral-50 text-xs">
              <LayoutTemplate className="w-4 h-4 text-neutral-600" />
              <span className="font-semibold text-neutral-800">
                Default profile: {jobProfile?.name ?? "None"}
              </span>
              <span className="text-neutral-500">
                Fixed once the batch is analysed. Change it before analyzing to
                rebuild the assignments.
              </span>
            </div>
          )}

          {assignmentError && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
              <span>{assignmentError}</span>
            </div>
          )}

          {hasAnalyzed && (
            <div className="space-y-3 animate-in fade-in">
              <div className="overflow-x-auto border border-neutral-200 rounded-lg">
                <table className="w-full text-xs text-left">
                  <thead className="bg-neutral-50 border-b border-neutral-200 text-neutral-600 font-semibold">
                    <tr>
                      <th className="px-4 py-2">Filename</th>
                      <th className="px-4 py-2">Profile</th>
                      <th className="px-4 py-2">Status</th>
                      <th className="px-4 py-2">Confidence / Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {assignments.length === 0 ? (
                      <tr>
                        <td
                          colSpan={4}
                          className="p-6 text-center text-neutral-400"
                        >
                          No assignments found.
                        </td>
                      </tr>
                    ) : (
                      assignments.map((asgn) => (
                        <tr key={asgn.id} className="hover:bg-neutral-50">
                          <td className="px-4 py-2 font-medium text-neutral-900 truncate max-w-xs">
                            {asgn.filename}
                          </td>
                          <td className="px-4 py-2">
                            <select
                              value={asgn.profileId || ""}
                              onChange={(e) =>
                                handleUpdateAssignment(asgn.id, {
                                  profileId: e.target.value || null,
                                })
                              }
                              className="w-full px-2 py-1 bg-white border border-neutral-300 rounded text-xs focus:ring-1 focus:ring-neutral-900"
                            >
                              <option value="">No Profile / Exclude</option>
                              {profiles.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-4 py-2">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${asgn.assignmentStatus === "assigned"
                                  ? "bg-emerald-100 text-emerald-800"
                                  : asgn.assignmentStatus === "ambiguous"
                                    ? "bg-amber-100 text-amber-800"
                                    : asgn.assignmentStatus === "excluded"
                                      ? "bg-neutral-100 text-neutral-800"
                                      : "bg-rose-100 text-rose-800"
                                }`}
                            >
                              {asgn.assignmentStatus}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-neutral-500">
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-bold text-neutral-700">
                                {Math.round(
                                  (asgn.assignmentConfidence || 0) * 100,
                                )}
                                %
                              </span>
                              <span className="truncate max-w-xs">
                                {asgn.assignmentReason}
                              </span>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleAnalyzeDocuments}
                  className="text-xs text-neutral-600 hover:text-neutral-900 flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Re-analyze</span>
                </button>
              </div>
            </div>
          )}

          {/* Step 4: Start Processing Button */}
          <div className="pt-4 border-t border-neutral-200 flex items-center justify-between">
            <span className="text-xs text-neutral-500">
              {hasAnalyzed
                ? `Ready to process ${archiveResult.pdfFiles.length} PDF documents with confirmed assignments.`
                : "Please analyze documents before starting the pipeline."}
            </span>
            <button
              type="button"
              onClick={handleStart}
              disabled={isProcessing || !hasAnalyzed}
              className="flex items-center gap-2 px-5 py-2.5 text-xs font-bold text-white bg-neutral-900 hover:bg-neutral-800 rounded-md transition-colors shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Play className="w-4 h-4 fill-current" />
              <span>Start Extraction Pipeline</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
