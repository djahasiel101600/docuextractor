/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  Upload,
  FileArchive,
  FileText,
  AlertCircle,
  Play,
  Sparkles,
  FolderTree,
  ChevronDown,
  ChevronRight,
  Sliders,
  CheckCircle2,
  FileWarning,
  RefreshCw,
  Folder,
  Search,
  X,
  History,
  Gauge,
  Clock,
} from 'lucide-react';
import {
  ExtractionProfile,
  FieldDefinition,
  PDFDocumentRecord,
} from '../../types/extraction';
import {
  unpackZipArchive,
  collectLoosePdfFiles,
  ArchiveDiscoveryResult,
  DiscoveredFileItem,
} from '../../services/zipService';
import { createDemoZipArchive } from '../../services/sampleArchiveGenerator';
import { extractFromFilename } from '../../services/extractionEngine';

interface JobSetupViewProps {
  profiles: ExtractionProfile[];
  selectedProfileId: string;
  onSelectProfileId: (id: string) => void;
  onStartProcessing: (
    archiveResult: ArchiveDiscoveryResult,
    profile: ExtractionProfile
  ) => void;
  isProcessing: boolean;
  processingProgress: {
    phase: 'uploading' | 'processing';
    total: number;
    completed: number;
    failed: number;
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

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return 'Calculating...';
  const totalSeconds = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

// Returns the lowercased extension of a filename (without the dot), or '' when
// there is none (e.g. dotfiles or names ending in a trailing dot).
function getExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx <= 0 || idx === filename.length - 1) return '';
  return filename.slice(idx + 1).toLowerCase();
}

// Human-readable byte size. Unsupported entries in the ZIP path may report 0
// when the archive header exposes no size, so fall back to a neutral label.
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Categories used to group unsupported non-PDF files for readability.
const UNSUPPORTED_CATEGORIES: { label: string; extensions: string[] }[] = [
  { label: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'heic', 'heif', 'svg'] },
  { label: 'Spreadsheets', extensions: ['xlsx', 'xls', 'xlsm', 'xlsb', 'csv', 'tsv', 'ods'] },
  { label: 'Documents', extensions: ['doc', 'docx', 'rtf', 'odt', 'pages', 'epub'] },
  { label: 'Presentations', extensions: ['ppt', 'pptx', 'key', 'odp'] },
  { label: 'Text & data', extensions: ['txt', 'md', 'log', 'json', 'xml', 'yaml', 'yml'] },
  { label: 'Archives', extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'] },
  { label: 'Audio & video', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'mp4', 'mov', 'avi', 'mkv', 'wmv'] },
];

interface UnsupportedGroup {
  label: string;
  extensions: string[];
  items: DiscoveredFileItem[];
}

// Buckets unsupported files into known categories (by extension) and one
// "Other" bucket per unrecognized extension, so the panel reads naturally
// (e.g. "Spreadsheets (.xlsx): 3", "Other (.psd): 1").
function groupUnsupportedFiles(items: DiscoveredFileItem[]): UnsupportedGroup[] {
  const extToCategory = new Map<string, string>();
  UNSUPPORTED_CATEGORIES.forEach((category) =>
    category.extensions.forEach((ext) => extToCategory.set(ext, category.label))
  );

  const buckets = new Map<string, { label: string; order: number; items: DiscoveredFileItem[] }>();
  items.forEach((item) => {
    const ext = getExtension(item.filename);
    const categoryLabel = ext ? extToCategory.get(ext) : undefined;
    const key = categoryLabel ?? `other:${ext || 'none'}`;
    const label = categoryLabel ?? 'Other';
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
        new Set(bucket.items.map((item) => getExtension(item.filename)).filter(Boolean))
      ).sort(),
      items: bucket.items,
      order: bucket.order,
    }))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

// --- Processing time estimation (tunable heuristic) ------------------------
// Rough wall-clock seconds per document per configured target field. Kept as
// constants at the top of the component file so the estimate is easy to adjust
// after real profiling. Very large archives will only ever get a rough figure.
const ESTIMATE_SECONDS_PER_DOC_PER_FIELD_MIN = 2;
const ESTIMATE_SECONDS_PER_DOC_PER_FIELD_MAX = 5;

// --- "Re-use last archive" cache -------------------------------------------
const ARCHIVE_CACHE_STORAGE_KEY = 'docuextract.lastArchiveMeta';

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
  } catch {
    // ignore
  }
}

export const JobSetupView: React.FC<JobSetupViewProps> = ({
  profiles,
  selectedProfileId,
  onSelectProfileId,
  onStartProcessing,
  isProcessing,
  processingProgress,
}) => {
  const [archiveResult, setArchiveResult] = useState<ArchiveDiscoveryResult | null>(null);
  const [isUnpacking, setIsUnpacking] = useState(false);
  const [unpackError, setUnpackError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [showRegexTester, setShowRegexTester] = useState(false);

  // Step 2 discovery UI state. The filename filter is purely visual: it never
  // mutates archiveResult.pdfFiles or excludes anything from processing.
  const [filenameFilter, setFilenameFilter] = useState('');
  const [debouncedFilter, setDebouncedFilter] = useState('');
  const [showUnsupported, setShowUnsupported] = useState(false);
  const [showInsights, setShowInsights] = useState(false);

  // "Re-use last archive" state. The full object lives in a module-scoped
  // cache (with binary data) for instant, processable restore; this component
  // state mirrors it for reactive UI.
  const [cachedArchive, setCachedArchive] = useState<ArchiveDiscoveryResult | null>(null);
  const [cachedArchiveMeta, setCachedArchiveMeta] = useState<ArchiveCacheMeta | null>(null);

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
        readArchiveMeta() ?? buildArchiveMeta(inMemoryArchiveCache)
      );
    } else {
      removeArchiveMeta();
    }
  }, []);

  const resetDiscoveryViews = () => {
    setFilenameFilter('');
    setDebouncedFilter('');
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
        'The previous archive is no longer available in this browser session. Please upload it again.'
      );
      return;
    }
    resetDiscoveryViews();
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
    [archiveResult]
  );

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeProfile = profiles.find((p) => p.id === selectedProfileId) || profiles[0];

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
      const firstFile = files[0];
      const isZip = firstFile.name.toLowerCase().endsWith('.zip');

      let result: ArchiveDiscoveryResult;
      if (isZip) {
        result = await unpackZipArchive(firstFile, firstFile.name);
      } else {
        // Multiple loose PDF files
        const fileArray = Array.from(files);
        result = await collectLoosePdfFiles(fileArray);
      }
      setArchiveResult(result);
      rememberArchive(result);
      resetDiscoveryViews();
    } catch (err: unknown) {
      setUnpackError(err instanceof Error ? err.message : 'Failed to read uploaded archive');
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
      const result = await unpackZipArchive(demoBlob, 'batch_2026_q1_civil_forms.zip');
      setArchiveResult(result);
      rememberArchive(result);
      resetDiscoveryViews();
    } catch (err: unknown) {
      setUnpackError(err instanceof Error ? err.message : 'Failed to generate demo archive');
    } finally {
      setIsUnpacking(false);
    }
  };

  const handleStart = () => {
    if (!archiveResult || !activeProfile || archiveResult.pdfFiles.length === 0) return;
    onStartProcessing(archiveResult, activeProfile);
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8">

      {/* View Title */}
      <div>
        <h2 className="text-xl font-bold text-neutral-900 tracking-tight">
          New Document Processing Job
        </h2>
        <p className="text-xs text-neutral-500 mt-1">
          Upload a ZIP archive containing multiple digital PDF forms or test with our sample archive.
        </p>
      </div>

      {/* Live processing progress is surfaced by the global banner in App so it
          stays visible across tabs and after a reload. */}

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

          {/* Quick Demo Button + Re-use last archive */}
          <div className="flex items-center gap-2">
            {cachedArchive && (
              <button
                type="button"
                onClick={handleReuseArchive}
                disabled={isUnpacking || isProcessing}
                title={
                  cachedArchiveMeta
                    ? `${cachedArchiveMeta.zipName} · ${cachedArchiveMeta.pdfCount} PDFs`
                    : 'Re-use the last discovered archive'
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
            ? 'border-neutral-900 bg-neutral-50'
            : 'border-neutral-300 hover:border-neutral-400 bg-neutral-50/50'
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
                {isUnpacking ? 'Reading & unpacking archive contents...' : 'Click to browse or drop ZIP archive here'}
              </p>
              <p className="text-xs text-neutral-500 mt-1">
                Supports nested directories, folder structures, or multiple loose .pdf files.
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

      {/* Step 2: Archive Discovered Contents */}
      {archiveResult && (
        <div className="bg-white rounded-xl border border-neutral-200 p-6 shadow-xs space-y-5 animate-in fade-in">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-neutral-900 text-white text-xs font-bold flex items-center justify-center">
                2
              </span>
              <div>
                <h3 className="text-sm font-bold text-neutral-900">
                  Discovered Documents ({archiveResult.pdfFiles.length} PDFs)
                </h3>
                <p className="text-xs text-neutral-500 font-mono">
                  Archive: {archiveResult.zipName} · {Math.round(archiveResult.zipSizeBytes / 1024)} KB total
                </p>
              </div>
            </div>
          </div>

          {/* Filename filter (visual only: never changes what gets processed) */}
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
                onClick={() => setFilenameFilter('')}
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
                <div key={file.id} className="p-2.5 px-4 flex items-center justify-between hover:bg-neutral-50">
                  <div className="flex items-center gap-2.5 truncate">
                    <FileText className="w-4 h-4 text-neutral-500 shrink-0" />
                    <span className="font-medium text-neutral-900 truncate">
                      {file.filename}
                    </span>
                    <span className="text-neutral-400 font-mono text-[11px] truncate">
                      ({file.relativePath})
                    </span>
                  </div>
                  <span className="text-neutral-400 font-mono text-[11px] shrink-0 tabular-nums">
                    {Math.round(file.sizeBytes / 1024)} KB
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Processing Insights: collapsible stats + estimate + unsupported */}
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
                <span className="tabular-nums">{formatBytes(archiveStats.total)}</span>
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
                {/* Aggregate stats */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div className="p-2.5 rounded border border-neutral-200 bg-neutral-50">
                    <div className="text-[10px] uppercase tracking-wide text-neutral-500">Total PDFs</div>
                    <div className="text-sm font-bold text-neutral-900 tabular-nums">{archiveStats.count}</div>
                  </div>
                  <div className="p-2.5 rounded border border-neutral-200 bg-neutral-50">
                    <div className="text-[10px] uppercase tracking-wide text-neutral-500">Total Size</div>
                    <div className="text-sm font-bold text-neutral-900 tabular-nums">{formatBytes(archiveStats.total)}</div>
                  </div>
                  <div className="p-2.5 rounded border border-neutral-200 bg-neutral-50">
                    <div className="text-[10px] uppercase tracking-wide text-neutral-500">Avg File Size</div>
                    <div className="text-sm font-bold text-neutral-900 tabular-nums">{formatBytes(archiveStats.avg)}</div>
                  </div>
                  <div className="p-2.5 rounded border border-neutral-200 bg-neutral-50">
                    <div className="text-[10px] uppercase tracking-wide text-neutral-500">Size Range</div>
                    <div className="text-[11px] font-semibold text-neutral-900 tabular-nums">
                      {archiveStats.count > 0
                        ? `${formatBytes(archiveStats.min)} \u2013 ${formatBytes(archiveStats.max)}`
                        : 'N/A'}
                    </div>
                  </div>
                </div>

                {/* Estimated processing time */}
                <div className="flex items-start gap-2 p-2.5 rounded border border-neutral-200 bg-neutral-50">
                  <Clock className="w-4 h-4 text-neutral-500 shrink-0 mt-0.5" />
                  <div className="text-neutral-700">
                    {archiveStats.count === 0 ? (
                      <span>No PDFs to process.</span>
                    ) : (
                      <>
                        <span className="font-semibold text-neutral-900">
                          Estimated processing: ~{formatDuration(archiveStats.minSeconds)}&ndash;{formatDuration(archiveStats.maxSeconds)}
                        </span>{' '}
                        for {archiveStats.count} {archiveStats.count === 1 ? 'PDF' : 'PDFs'} with{' '}
                        {archiveStats.fieldCount} {archiveStats.fieldCount === 1 ? 'field' : 'fields'}
                        {archiveStats.count > 50 ? ' (rough estimate)' : ''}.
                      </>
                    )}
                  </div>
                </div>

                {/* Unsupported (non-PDF) files breakdown */}
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
                          DocuExtractor only processes PDF documents &mdash; other
                          formats cannot be parsed for form-field extraction, so
                          they are ignored and not added to this job.
                        </p>

                        {unsupportedGroups.map((group) => (
                          <div key={`${group.label}:${group.extensions.join(',')}`} className="space-y-1">
                            <div className="font-semibold text-neutral-800">
                              {group.extensions.length > 0
                                ? `${group.label} (${group.extensions.map((ext) => `.${ext}`).join(', ')})`
                                : group.label}
                              {`: ${group.items.length}`}
                            </div>
                            <div className="rounded border border-neutral-200 bg-white divide-y divide-neutral-100">
                              {group.items.map((item) => {
                                const ext = getExtension(item.filename);
                                return (
                                  <div key={item.id} className="p-2 px-3 flex items-center justify-between gap-3">
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
                                        {ext ? `.${ext}` : 'no ext'}
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

      {/* Step 3: Extraction Profile & Live Filename Regex Tester */}
      {archiveResult && (
        <div className="bg-white rounded-xl border border-neutral-200 p-6 shadow-xs space-y-5 animate-in fade-in">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-neutral-900 text-white text-xs font-bold flex items-center justify-center">
                3
              </span>
              <div>
                <h3 className="text-sm font-bold text-neutral-900">
                  Select Extraction Profile &amp; Verify Rules
                </h3>
                <p className="text-xs text-neutral-500">
                  Choose the field extraction rules and regex patterns for this document batch.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowRegexTester(!showRegexTester)}
              className="text-xs text-neutral-700 hover:text-neutral-900 border border-neutral-200 px-3 py-1.5 rounded-md bg-neutral-50 hover:bg-neutral-100 flex items-center gap-1.5"
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>{showRegexTester ? 'Hide Live Regex Preview' : 'Preview Live Regex Matches'}</span>
            </button>
          </div>

          {/* Profile Selector Dropdown */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-700 block">
                Active Profile Template
              </label>
              <select
                value={selectedProfileId}
                onChange={(e) => onSelectProfileId(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-white border border-neutral-300 rounded-md focus:outline-hidden focus:ring-2 focus:ring-neutral-900 font-medium"
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.fields.length} fields)
                  </option>
                ))}
              </select>
            </div>

            <div className="p-3 bg-neutral-50 border border-neutral-200 rounded-lg text-xs space-y-1">
              <span className="font-semibold text-neutral-800">
                {activeProfile.name}
              </span>
              <p className="text-neutral-600 leading-relaxed text-[11px]">
                {activeProfile.description}
              </p>
              <div className="text-[11px] text-neutral-500 pt-1 font-mono">
                OCR Fallback: {activeProfile.ocrSettings.enabledFallback ? 'Enabled' : 'Disabled'} · Min threshold: {activeProfile.ocrSettings.minTextLengthThreshold} chars
              </div>
            </div>
          </div>

          {/* Configured Fields Chips */}
          <div className="space-y-1.5 pt-2">
            <span className="text-xs font-semibold text-neutral-700 block">
              Configured Target Fields ({activeProfile.fields.length})
            </span>
            <div className="flex flex-wrap gap-2">
              {activeProfile.fields.map((f) => (
                <div
                  key={f.id}
                  className="px-2.5 py-1 rounded bg-neutral-100 text-neutral-800 text-xs flex items-center gap-1.5"
                >
                  <span className="font-medium">{f.name}</span>
                  <span className="text-[10px] text-neutral-500 font-mono">
                    [{f.type}]
                  </span>
                  {f.required && (
                    <span className="text-[10px] text-rose-600 font-semibold">*</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Interactive Live Regex Tester on Discovered Filenames */}
          {showRegexTester && (
            <div className="p-4 rounded-lg bg-neutral-900 text-neutral-200 space-y-3 font-mono text-xs">
              <div className="flex items-center justify-between border-b border-neutral-800 pb-2">
                <span className="font-bold text-white">
                  Live Filename Regex Matches on Discovered Files
                </span>
                <span className="text-[11px] text-neutral-400">
                  Testing against {archiveResult.pdfFiles.slice(0, 3).length} sample files
                </span>
              </div>

              <div className="space-y-3 max-h-60 overflow-y-auto">
                {archiveResult.pdfFiles.slice(0, 4).map((file) => (
                  <div key={file.id} className="p-2.5 bg-neutral-800 rounded space-y-1.5">
                    <div className="text-amber-400 font-bold truncate">
                      Filename: {file.filename}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                      {activeProfile.fields
                        .filter((f) => f.filenameRules.enabled)
                        .map((f) => {
                          const res = extractFromFilename(file.filename, f);
                          return (
                            <div key={f.id} className="flex items-center gap-1.5 truncate">
                              <span className="text-neutral-400">{f.name}:</span>
                              {res.value ? (
                                <span className="text-emerald-400 font-bold bg-emerald-950/80 px-1.5 py-0.5 rounded">
                                  {res.value}
                                </span>
                              ) : (
                                <span className="text-neutral-500 italic">No regex match</span>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Step 4: Start Processing Button */}
          <div className="pt-4 border-t border-neutral-200 flex items-center justify-between">
            <span className="text-xs text-neutral-500">
              Ready to process {archiveResult.pdfFiles.length} PDF documents with &quot;{activeProfile.name}&quot;.
            </span>
            <button
              type="button"
              onClick={handleStart}
              disabled={isProcessing}
              className="flex items-center gap-2 px-5 py-2.5 text-xs font-bold text-white bg-neutral-900 hover:bg-neutral-800 rounded-md transition-colors shadow-xs"
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
