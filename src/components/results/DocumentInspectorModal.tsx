/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  FileText,
  RotateCcw,
  Check,
  Save,
  Pencil,
  ArrowRight,
  Sparkles,
  Download,
  LayoutTemplate,
  Eye,
  Ban,
  Copy,
  Keyboard,
  ChevronDown,
  SkipForward,
  FileInput,
  ScanText,
  FileSearch,
  FileType2,
} from 'lucide-react';
import { PDFDocumentRecord, ExtractionProfile, FieldDefinition } from '../../types/extraction';
import { renderPdfPageToCanvas } from '../../services/pdfService';

/* -------------------------------------------------------------------------- */
/*  Constants & helpers                                                       */
/* -------------------------------------------------------------------------- */

const ASSIGNMENT_BADGE_LABEL: Record<PDFDocumentRecord['assignmentStatus'], string> = {
  legacy: 'Job default',
  assigned: 'Auto-assigned',
  manual: 'Manual override',
  ambiguous: 'Ambiguous match',
  unassigned: 'Unassigned',
  excluded: 'Excluded',
};

const ASSIGNMENT_BADGE_STYLES: Record<PDFDocumentRecord['assignmentStatus'], string> = {
  legacy: 'border-neutral-200 bg-neutral-50 text-neutral-600',
  assigned: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  manual: 'border-blue-200 bg-blue-50 text-blue-800',
  ambiguous: 'border-amber-200 bg-amber-50 text-amber-900',
  unassigned: 'border-rose-200 bg-rose-50 text-rose-700',
  excluded: 'border-neutral-300 bg-neutral-200 text-neutral-700',
};

const STATUS_STYLES: Record<string, string> = {
  MATCHED: 'bg-emerald-100 text-emerald-800',
  MISMATCH: 'bg-amber-100 text-amber-900',
  INVALID: 'bg-rose-100 text-rose-900',
  OCR_EXTRACTED: 'bg-purple-100 text-purple-900',
  AI_EXTRACTED: 'bg-sky-100 text-sky-900',
  FILENAME_ONLY: 'bg-amber-50 text-amber-800 border border-amber-200',
};

type SourceTone = 'neutral' | 'emerald' | 'purple' | 'sky';

const TONE_STYLES: Record<
  SourceTone,
  { row: string; selectedRow: string; title: string; value: string; meta: string; icon: string }
> = {
  neutral: {
    row: 'bg-white',
    selectedRow: 'bg-neutral-50',
    title: 'text-neutral-800',
    value: 'text-neutral-900',
    meta: 'text-neutral-500',
    icon: 'text-neutral-500',
  },
  emerald: {
    row: 'bg-emerald-50/50',
    selectedRow: 'bg-emerald-50',
    title: 'text-emerald-900',
    value: 'text-emerald-950',
    meta: 'text-emerald-800',
    icon: 'text-emerald-600',
  },
  purple: {
    row: 'bg-purple-50/40',
    selectedRow: 'bg-purple-50',
    title: 'text-purple-900',
    value: 'text-purple-950',
    meta: 'text-purple-800',
    icon: 'text-purple-600',
  },
  sky: {
    row: 'bg-sky-50/50',
    selectedRow: 'bg-sky-50',
    title: 'text-sky-900',
    value: 'text-sky-950',
    meta: 'text-sky-800',
    icon: 'text-sky-700',
  },
};

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['J', 'K'], label: 'Next / previous field' },
  { keys: ['N'], label: 'Jump to next field needing attention' },
  { keys: ['1', '2', '3', '4', '5'], label: 'Use the numbered source value' },
  { keys: ['E'], label: 'Edit value' },
  { keys: ['Enter'], label: 'Save edit (while editing)' },
  { keys: ['R'], label: 'Mark reviewed / unreviewed' },
  { keys: ['[', ']'], label: 'Previous / next page' },
  { keys: ['+', '−', '0'], label: 'Zoom in / out / reset' },
  { keys: ['Esc'], label: 'Cancel edit, then close' },
];

type FieldHealth = 'edited' | 'invalid' | 'conflict' | 'missing' | 'ok';

const HEALTH_META: Record<FieldHealth, { dot: string; label: string }> = {
  edited: { dot: 'bg-blue-500', label: 'Manually edited' },
  invalid: { dot: 'bg-rose-500', label: 'Invalid format' },
  conflict: { dot: 'bg-amber-500', label: 'Sources conflict' },
  missing: { dot: 'bg-neutral-400 ring-2 ring-neutral-200', label: 'Required value missing' },
  ok: { dot: 'bg-emerald-500', label: 'Looks good' },
};

const getFieldHealth = (
  field: FieldDefinition,
  diag: PDFDocumentRecord['diagnostics'][string] | undefined,
): FieldHealth => {
  if (diag?.isManuallyCorrected) return 'edited';
  if (diag?.status === 'INVALID' || diag?.validationPassed === false) return 'invalid';
  if (diag?.isConflict || diag?.status === 'MISMATCH') return 'conflict';
  if (diag?.status === 'NOT_FOUND' && field.required) return 'missing';
  return 'ok';
};

const needsAttention = (health: FieldHealth) =>
  health === 'invalid' || health === 'conflict' || health === 'missing';

const isTypingTarget = (el: EventTarget | null) => {
  const node = el as HTMLElement | null;
  if (!node || !node.tagName) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
};

const Kbd: React.FC<{ children: React.ReactNode; dark?: boolean }> = ({ children, dark }) => (
  <kbd
    className={`inline-flex min-w-[1.25rem] items-center justify-center rounded border px-1 py-px font-mono text-[10px] font-semibold leading-none ${dark
      ? 'border-white/30 bg-white/10 text-white/90'
      : 'border-neutral-300 bg-white text-neutral-600'
      }`}
  >
    {children}
  </kbd>
);

/* -------------------------------------------------------------------------- */
/*  Source row (one candidate value from one extraction source)               */
/* -------------------------------------------------------------------------- */

interface SourceRowProps {
  title: string;
  icon?: React.ReactNode;
  tone?: SourceTone;
  value?: string | null;
  emptyText?: string;
  isSelectedSource?: boolean;
  selectedLabel?: string;
  isCurrent: boolean;
  shortcut?: number;
  details?: React.ReactNode[];
  onUse: () => void;
}

const SourceRow: React.FC<SourceRowProps> = ({
  title,
  icon,
  tone = 'neutral',
  value,
  emptyText = 'No match',
  isSelectedSource,
  selectedLabel = 'Selected source',
  isCurrent,
  shortcut,
  details,
  onUse,
}) => {
  const t = TONE_STYLES[tone];
  const hasValue = Boolean(value);

  return (
    <div
      className={`flex items-start justify-between gap-4 border-b border-neutral-200 p-3 last:border-b-0 ${isSelectedSource ? t.selectedRow : t.row
        }`}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`flex items-center gap-1.5 text-xs font-semibold ${t.title}`}>
            {icon && <span className={t.icon}>{icon}</span>}
            {title}
          </span>
          {isSelectedSource && (
            <span className="rounded-full bg-neutral-900 px-1.5 py-px text-[10px] font-medium text-white">
              {selectedLabel}
            </span>
          )}
        </div>
        <div className={`break-words font-mono text-xs ${hasValue ? t.value : 'italic text-neutral-400'}`}>
          {hasValue ? value : emptyText}
        </div>
        {details?.filter(Boolean).map((d, i) => (
          <p key={i} className={`whitespace-pre-wrap break-words text-[11px] leading-relaxed ${t.meta}`}>
            {d}
          </p>
        ))}
      </div>

      {hasValue &&
        (isCurrent ? (
          <span className="mt-0.5 flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-800">
            <Check className="h-3 w-3" /> In use
          </span>
        ) : (
          <button
            type="button"
            onClick={onUse}
            className="mt-0.5 flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded border border-neutral-300 bg-white px-2 py-1 text-[11px] font-medium text-neutral-800 transition-colors hover:border-neutral-900 hover:bg-neutral-900 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
          >
            Use this value
            {shortcut !== undefined && <Kbd>{shortcut}</Kbd>}
          </button>
        ))}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/*  Collapsible section                                                       */
/* -------------------------------------------------------------------------- */

const Collapsible: React.FC<{
  title: string;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}> = ({ title, badge, defaultOpen = false, children }) => (
  <details open={defaultOpen} className="group rounded-lg border border-neutral-200 bg-white">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-50 [&::-webkit-details-marker]:hidden">
      <span className="flex items-center gap-2">
        {title}
        {badge}
      </span>
      <ChevronDown className="h-3.5 w-3.5 text-neutral-400 transition-transform group-open:rotate-180" />
    </summary>
    <div className="border-t border-neutral-200 p-3.5">{children}</div>
  </details>
);

/* -------------------------------------------------------------------------- */
/*  Main component                                                            */
/* -------------------------------------------------------------------------- */

interface DocumentInspectorModalProps {
  document: PDFDocumentRecord;
  profile: ExtractionProfile;
  onClose: () => void;
  onUpdateFieldValue: (docId: string, fieldId: string, newValue: string) => void;
  onToggleReviewed: (docId: string) => void;
}

export const DocumentInspectorModal: React.FC<DocumentInspectorModalProps> = ({
  document: doc,
  profile,
  onClose,
  onUpdateFieldValue,
  onToggleReviewed,
}) => {
  const [activeFieldId, setActiveFieldId] = useState<string>(profile.fields[0]?.id || '');
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [zoomScale, setZoomScale] = useState<number>(1.2);
  const [isRendering, setIsRendering] = useState<boolean>(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'canvas' | 'form'>('canvas');
  const [pdfBuffer, setPdfBuffer] = useState<ArrayBuffer | null>(doc.fileData || null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  // Field editing state
  const [editingValue, setEditingValue] = useState<string>('');
  const [isEditing, setIsEditing] = useState<boolean>(false);

  // Review-flow UX state
  const [autoAdvance, setAutoAdvance] = useState<boolean>(true);
  const [flash, setFlash] = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState<boolean>(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const activeChipRef = useRef<HTMLButtonElement | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  const activeField: FieldDefinition | undefined = profile.fields.find((f) => f.id === activeFieldId);
  const activeDiagnostic = doc.diagnostics[activeFieldId];
  const currentValue = doc.finalValues[activeFieldId] || activeDiagnostic?.finalValue || '';

  const fieldIndex = profile.fields.findIndex((f) => f.id === activeFieldId);
  const fieldHealth = profile.fields.map((f) => getFieldHealth(f, doc.diagnostics[f.id]));
  const attentionCount = fieldHealth.filter(needsAttention).length;
  const editedCount = fieldHealth.filter((h) => h === 'edited').length;
  const isDirty = isEditing && editingValue !== currentValue;

  /* ------------------------------- Effects -------------------------------- */

  // A batch can mix profiles, so the fields offered here must belong to the
  // profile this document was actually extracted with.
  useEffect(() => {
    if (!profile.fields.some((field) => field.id === activeFieldId)) {
      setActiveFieldId(profile.fields[0]?.id || '');
    }
  }, [profile.fields, activeFieldId]);

  useEffect(() => {
    setEditingValue(currentValue);
    setIsEditing(false);
  }, [activeFieldId, currentValue]);

  // When active field has a specific page number, jump to that page
  useEffect(() => {
    if (activeDiagnostic?.pageNumber && activeDiagnostic.pageNumber !== currentPage) {
      setCurrentPage(activeDiagnostic.pageNumber);
    }
  }, [activeFieldId]);

  // The parent loads the PDF from the backend API before opening the inspector.
  useEffect(() => {
    if (!doc.fileData) {
      setPdfBuffer(null);
      setRenderError('The PDF file is unavailable from the local service.');
    } else {
      setPdfBuffer(doc.fileData);
      setRenderError(null);
    }
  }, [doc.fileData]);

  // Create persistent Blob URL for direct download or local opening
  useEffect(() => {
    if (!pdfBuffer) {
      setBlobUrl(null);
      return;
    }
    const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    setBlobUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [pdfBuffer]);

  // Render PDF to Canvas with live active field highlighting and accurate document fallbackData
  useEffect(() => {
    if (!pdfBuffer || !canvasRef.current || viewMode !== 'canvas') return;

    let isMounted = true;
    setIsRendering(true);
    setRenderError(null);

    // A reviewer compares extracted values against this canvas, so a synthetic
    // fallback page would falsely "confirm" the extraction. Fail visibly.
    renderPdfPageToCanvas(
      pdfBuffer,
      currentPage,
      canvasRef.current,
      zoomScale,
      currentValue,
      undefined,
      { allowFallback: false }
    )
      .then(() => {
        if (isMounted) setIsRendering(false);
      })
      .catch((err) => {
        if (isMounted) {
          setIsRendering(false);
          setRenderError(err instanceof Error ? err.message : 'Unable to render PDF preview');
        }
      });

    return () => {
      isMounted = false;
    };
  }, [pdfBuffer, currentPage, zoomScale, viewMode, currentValue]);

  // Lock background scroll and move focus into the dialog while it is open.
  useEffect(() => {
    const previouslyFocused = window.document.activeElement as HTMLElement | null;
    const previousOverflow = window.document.body.style.overflow;
    window.document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    return () => {
      window.document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  // Keep the active field chip visible in the horizontal selector.
  useEffect(() => {
    activeChipRef.current?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [activeFieldId]);

  // Focus the input when editing begins.
  useEffect(() => {
    if (isEditing) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [isEditing]);

  useEffect(
    () => () => {
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    },
    [],
  );

  /* ------------------------------ Actions --------------------------------- */

  const showFlash = (message: string) => {
    setFlash(message);
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlash(null), 2200);
  };

  const goToField = (index: number) => {
    const f = profile.fields[index];
    if (f) setActiveFieldId(f.id);
  };

  /** Jumps to the next field (after the current one, wrapping) that needs a look. */
  const goToNextIssue = (): boolean => {
    const n = profile.fields.length;
    for (let step = 1; step < n; step++) {
      const idx = (fieldIndex + step) % n;
      if (needsAttention(fieldHealth[idx])) {
        goToField(idx);
        return true;
      }
    }
    return false;
  };

  const commitValue = (val: string) => {
    onUpdateFieldValue(doc.id, activeFieldId, val);
    setEditingValue(val);
    setIsEditing(false);
    showFlash(`${activeField?.name ?? 'Field'} saved`);
    if (autoAdvance) goToNextIssue();
  };

  const handleSaveCorrection = () => commitValue(editingValue);
  const handleQuickAccept = (val: string) => commitValue(val);

  const startEditing = () => {
    setEditingValue(currentValue);
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditingValue(currentValue);
  };

  const handleCopy = async () => {
    if (!currentValue) return;
    try {
      await navigator.clipboard.writeText(currentValue);
      showFlash('Value copied');
    } catch {
      showFlash('Copy is not available in this browser');
    }
  };

  const handleRequestClose = () => {
    if (isDirty && !window.confirm('Discard your unsaved edit?')) return;
    onClose();
  };

  const totalPages = doc.pageCount || 1;

  /* --------------------- Source candidates (data-driven) ------------------- */

  const d = activeDiagnostic;
  const sourceRows: (Omit<SourceRowProps, 'isCurrent' | 'shortcut' | 'onUse'> & { key: string })[] = d
    ? [
      {
        key: 'filename',
        title: 'Filename pattern',
        icon: <FileType2 className="h-3.5 w-3.5" />,
        value: d.filenameValue,
        isSelectedSource: d.source === 'filename',
        details: [activeField?.filenameRules.patterns[0] ? `Rule: ${activeField.filenameRules.patterns[0]}` : null],
      },
      ...(d.formValue
        ? [
          {
            key: 'form',
            title: 'Form field value',
            icon: <FileInput className="h-3.5 w-3.5" />,
            tone: 'emerald' as SourceTone,
            value: d.formValue,
            isSelectedSource: d.source === 'form_field',
            details: [
              d.formConfidenceScore !== undefined
                ? `Evidence score: ${Math.round((d.formConfidenceScore ?? 0) * 100)}%${d.formMethod ? ` · ${d.formMethod.replace('acroform_', 'AcroForm ')}` : ''
                }${d.formPageNumber ? ` · Page ${d.formPageNumber}` : ''}`
                : null,
              d.formEvidence ? `Evidence: ${d.formEvidence}` : null,
            ],
          },
        ]
        : []),
      {
        key: 'pdf',
        title: 'PDF text',
        icon: <FileSearch className="h-3.5 w-3.5" />,
        value: d.pdfValue,
        isSelectedSource: d.source === 'pdf_text',
        details: [
          d.candidateScores?.pdf_text !== undefined
            ? `Evidence score: ${Math.round(d.candidateScores.pdf_text * 100)}%${d.pdfPageNumber ? ` · Page ${d.pdfPageNumber}` : ''
            }`
            : null,
          d.pdfEvidence ? `Evidence: ${d.pdfEvidence}` : null,
          d.matchedPatternOrLabel ? `Label/Pattern: ${d.matchedPatternOrLabel}` : null,
        ],
      },
      ...(d.ocrValue
        ? [
          {
            key: 'ocr',
            title: 'OCR candidate',
            icon: <ScanText className="h-3.5 w-3.5" />,
            tone: 'purple' as SourceTone,
            value: d.ocrValue,
            details: [
              d.candidateScores?.ocr !== undefined
                ? `Evidence score: ${Math.round(d.candidateScores.ocr * 100)}%${d.ocrPageNumber ? ` · Page ${d.ocrPageNumber}` : ''
                }`
                : null,
              d.ocrEvidence ? `Evidence: ${d.ocrEvidence}` : null,
            ],
          },
        ]
        : []),
      ...(d.aiValue
        ? [
          {
            key: 'ai',
            title: 'AI candidate (Ollama)',
            icon: <Sparkles className="h-3.5 w-3.5" />,
            tone: 'sky' as SourceTone,
            value: d.aiValue,
            isSelectedSource: d.source === 'ai',
            selectedLabel: 'Selected source · verify',
            details: [
              d.aiEvidence
                ? `${d.aiSourceKind ? `Source: ${d.aiSourceKind} · ` : ''}Evidence: ${d.aiEvidence}${d.source === 'ai' && d.pageNumber ? ` (page ${d.pageNumber})` : ''
                }`
                : null,
            ],
          },
        ]
        : []),
    ]
    : [];

  // Number only the rows that actually have a value, in display order.
  let shortcutCounter = 0;
  const numberedRows = sourceRows.map((row) => ({
    ...row,
    shortcut: row.value ? ++shortcutCounter : undefined,
  }));

  /* --------------------------- Keyboard shortcuts -------------------------- */

  // Latest-closure pattern: one stable listener always sees fresh state.
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyHandlerRef.current = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      if (showShortcuts) setShowShortcuts(false);
      else if (isEditing) cancelEditing();
      else handleRequestClose();
      return;
    }

    if (isTypingTarget(e.target)) return;

    const key = e.key.toLowerCase();

    if (/^[1-9]$/.test(key)) {
      const row = numberedRows.find((r) => r.shortcut === Number(key));
      if (row?.value) {
        e.preventDefault();
        if (row.value === currentValue) showFlash('Already using this value');
        else handleQuickAccept(row.value);
      }
      return;
    }

    switch (key) {
      case 'j':
        e.preventDefault();
        if (fieldIndex < profile.fields.length - 1) goToField(fieldIndex + 1);
        break;
      case 'k':
        e.preventDefault();
        if (fieldIndex > 0) goToField(fieldIndex - 1);
        break;
      case 'n':
        e.preventDefault();
        if (!goToNextIssue()) showFlash('No other fields need attention');
        break;
      case 'e':
        if (activeField) {
          e.preventDefault();
          startEditing();
        }
        break;
      case 'r':
        e.preventDefault();
        onToggleReviewed(doc.id);
        break;
      case '[':
        if (viewMode === 'canvas') setCurrentPage((p) => Math.max(1, p - 1));
        break;
      case ']':
        if (viewMode === 'canvas') setCurrentPage((p) => Math.min(totalPages, p + 1));
        break;
      case '+':
      case '=':
        if (viewMode === 'canvas') setZoomScale((z) => Math.min(2.5, z + 0.2));
        break;
      case '-':
        if (viewMode === 'canvas') setZoomScale((z) => Math.max(0.6, z - 0.2));
        break;
      case '0':
        if (viewMode === 'canvas') setZoomScale(1.2);
        break;
      case '?':
        setShowShortcuts((s) => !s);
        break;
      default:
        break;
    }
  };

  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  /* -------------------------------- Render -------------------------------- */

  const statusBadgeClass = activeDiagnostic
    ? STATUS_STYLES[activeDiagnostic.status] || 'bg-neutral-200 text-neutral-800'
    : '';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/60 p-2 backdrop-blur-xs sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleRequestClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="inspector-title"
        tabIndex={-1}
        className="relative flex h-[96vh] w-full max-w-7xl flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl outline-hidden animate-in fade-in zoom-in-98 duration-150 sm:h-[92vh]"
      >
        {/* ---------------------------- Top bar ---------------------------- */}
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-neutral-200 bg-neutral-50/70 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="rounded-md border border-neutral-200 bg-white p-1.5 text-neutral-700">
              <FileText className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h3 id="inspector-title" className="max-w-lg truncate text-sm font-semibold text-neutral-900">
                  {doc.filename}
                </h3>
                {doc.isReviewed ? (
                  <span className="flex items-center gap-1 text-xs font-medium text-emerald-700">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Reviewed
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs font-medium text-amber-700">
                    <AlertTriangle className="h-3.5 w-3.5" /> Pending verification
                  </span>
                )}
                {attentionCount > 0 ? (
                  <button
                    type="button"
                    onClick={goToNextIssue}
                    className="flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900 transition-colors hover:bg-amber-100"
                    title="Jump to the next field that needs attention (N)"
                  >
                    <AlertCircle className="h-3 w-3" />
                    {attentionCount} of {profile.fields.length} need attention
                  </button>
                ) : (
                  <span className="flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
                    <Check className="h-3 w-3" />
                    All fields look good{editedCount > 0 ? ` · ${editedCount} edited` : ''}
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2">
                <p className="truncate font-mono text-xs text-neutral-500" title={doc.relativePath}>
                  {doc.relativePath} · {Math.round(doc.fileSizeBytes / 1024)} KB · {doc.pageCount} page(s) · Method:{' '}
                  {doc.extractionMethodUsed}
                </p>
                <span
                  className="inline-flex items-center gap-1 rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-neutral-700"
                  title={doc.assignmentRule || doc.assignmentReason || 'Extraction Profile used for this document'}
                >
                  <LayoutTemplate className="h-3 w-3" />
                  {doc.profileName || (doc.profileId ? profile.name : 'No profile assigned')}
                </span>
                <span
                  className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${ASSIGNMENT_BADGE_STYLES[doc.assignmentStatus]}`}
                  title={doc.assignmentReason || undefined}
                >
                  {doc.assignmentStatus === 'excluded' && <Ban className="h-3 w-3" />}
                  {ASSIGNMENT_BADGE_LABEL[doc.assignmentStatus]}
                </span>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => onToggleReviewed(doc.id)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 ${doc.isReviewed
                ? 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
                : 'bg-emerald-600 text-white hover:bg-emerald-700'
                }`}
              title="Toggle reviewed (R)"
            >
              <Check className="h-3.5 w-3.5" />
              <span>{doc.isReviewed ? 'Mark as unreviewed' : 'Mark as reviewed'}</span>
              <Kbd dark={!doc.isReviewed}>R</Kbd>
            </button>
            <button
              type="button"
              onClick={() => setShowShortcuts((s) => !s)}
              aria-pressed={showShortcuts}
              aria-label="Keyboard shortcuts"
              className="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-900"
              title="Keyboard shortcuts (?)"
            >
              <Keyboard className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={handleRequestClose}
              aria-label="Close inspector"
              className="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-900"
              title="Close (Esc)"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Shortcut cheat-sheet */}
        {showShortcuts && (
          <div
            role="region"
            aria-label="Keyboard shortcuts"
            className="absolute right-6 top-16 z-30 w-80 rounded-lg border border-neutral-200 bg-white p-4 shadow-xl"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-neutral-800">Keyboard shortcuts</span>
              <button
                type="button"
                onClick={() => setShowShortcuts(false)}
                aria-label="Close shortcuts"
                className="rounded p-0.5 text-neutral-400 hover:text-neutral-900"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <ul className="space-y-1.5">
              {SHORTCUTS.map((s) => (
                <li key={s.label} className="flex items-center justify-between gap-3 text-xs text-neutral-600">
                  <span>{s.label}</span>
                  <span className="flex shrink-0 gap-1">
                    {s.keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ---------------------------- Body ------------------------------- */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
          {/* ---------------- Left column: PDF preview ---------------- */}
          <div className="flex min-h-[40vh] flex-1 flex-col overflow-hidden border-b border-neutral-200 bg-neutral-100 md:min-h-0 md:border-b-0 md:border-r">
            {/* Toolbar */}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-600">
              <div className="flex items-center gap-1 rounded-md bg-neutral-100 p-0.5">
                <button
                  type="button"
                  onClick={() => setViewMode('canvas')}
                  aria-pressed={viewMode === 'canvas'}
                  className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${viewMode === 'canvas'
                    ? 'bg-white font-semibold text-neutral-900 shadow-xs'
                    : 'text-neutral-600 hover:text-neutral-900'
                    }`}
                  title="PDF canvas rendering with active field highlighting"
                >
                  <Eye className="h-3.5 w-3.5" />
                  <span>Canvas preview</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('form')}
                  aria-pressed={viewMode === 'form'}
                  className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${viewMode === 'form'
                    ? 'bg-white font-semibold text-neutral-900 shadow-xs'
                    : 'text-neutral-600 hover:text-neutral-900'
                    }`}
                  title="Structured form layout with extracted fields"
                >
                  <LayoutTemplate className="h-3.5 w-3.5" />
                  <span>Form view</span>
                </button>
                {blobUrl && (
                  <a
                    href={blobUrl}
                    download={doc.filename}
                    className="flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-medium text-neutral-600 transition-colors hover:bg-white hover:text-neutral-900"
                    title="Download original PDF file"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Download PDF</span>
                  </a>
                )}
              </div>

              {viewMode === 'canvas' && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={currentPage <= 1}
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    className="rounded p-1 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-30"
                    title="Previous page ( [ )"
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="px-1.5 font-mono tabular-nums">
                    Page {currentPage} of {totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={currentPage >= totalPages}
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    className="rounded p-1 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-30"
                    title="Next page ( ] )"
                    aria-label="Next page"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>

                  <span className="mx-1.5 h-4 w-px bg-neutral-200" aria-hidden />

                  <button
                    type="button"
                    onClick={() => setZoomScale((z) => Math.max(0.6, z - 0.2))}
                    className="rounded p-1 hover:bg-neutral-100"
                    title="Zoom out ( − )"
                    aria-label="Zoom out"
                  >
                    <ZoomOut className="h-4 w-4" />
                  </button>
                  <span className="w-10 text-center font-mono tabular-nums text-neutral-500">
                    {Math.round(zoomScale * 100)}%
                  </span>
                  <button
                    type="button"
                    onClick={() => setZoomScale((z) => Math.min(2.5, z + 0.2))}
                    className="rounded p-1 hover:bg-neutral-100"
                    title="Zoom in ( + )"
                    aria-label="Zoom in"
                  >
                    <ZoomIn className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setZoomScale(1.2)}
                    className="ml-0.5 rounded p-1 text-neutral-500 hover:bg-neutral-100"
                    title="Reset zoom ( 0 )"
                    aria-label="Reset zoom"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>

            {/* Viewport */}
            <div className="relative flex flex-1 items-start justify-center overflow-auto bg-neutral-200/50 p-4">
              {viewMode === 'canvas' ? (
                <>
                  {isRendering && (
                    <div
                      role="status"
                      className="pointer-events-none absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-neutral-200 bg-white/95 px-3 py-1.5 shadow-md"
                    >
                      <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-900 border-t-transparent motion-reduce:animate-none" />
                      <span className="text-xs font-medium text-neutral-700">Rendering page {currentPage}…</span>
                    </div>
                  )}

                  {renderError ? (
                    <div className="my-auto max-w-md space-y-4 rounded-xl border border-neutral-200 bg-white p-8 text-center shadow-md">
                      <AlertCircle className="mx-auto h-8 w-8 text-rose-500" />
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-neutral-900">Can’t show the PDF preview</p>
                        <p className="text-xs leading-relaxed text-neutral-600">{renderError}</p>
                      </div>
                      <div className="flex items-center justify-center gap-2 pt-2">
                        <button
                          type="button"
                          onClick={() => setViewMode('form')}
                          className="rounded-md bg-neutral-900 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-neutral-800"
                        >
                          Switch to form view
                        </button>
                        {blobUrl && (
                          <a
                            href={blobUrl}
                            download={doc.filename}
                            className="flex items-center gap-1.5 rounded-md border border-neutral-200 bg-neutral-100 px-3.5 py-1.5 text-xs font-semibold text-neutral-800 transition-colors hover:bg-neutral-200"
                          >
                            <Download className="h-3.5 w-3.5" />
                            <span>Download PDF</span>
                          </a>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="mx-auto overflow-hidden rounded-xs border border-neutral-300 bg-white shadow-lg">
                      <canvas ref={canvasRef} className="block" />
                    </div>
                  )}
                </>
              ) : (
                /* Form Document View: Authentic digital form rendering */
                <div className="my-auto w-full max-w-2xl space-y-6 rounded-lg border border-neutral-300 bg-white p-6 font-sans text-neutral-900 shadow-lg sm:p-8">
                  <div className="space-y-1 border-b-2 border-neutral-900 pb-4 text-center">
                    <span className="block text-[10px] font-bold uppercase tracking-widest text-neutral-500">
                      OFFICIAL CIVIL REGISTRY &amp; PUBLIC APPLICATION RECORD
                    </span>
                    <h2 className="text-lg font-black tracking-tight text-neutral-900">
                      {doc.filename.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ')}
                    </h2>
                    <p className="font-mono text-[11px] text-neutral-500">
                      Relative Archive Path: {doc.relativePath} · {Math.round(doc.fileSizeBytes / 1024)} KB
                    </p>
                  </div>

                  <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
                    {profile.fields.map((field, idx) => {
                      const diag = doc.diagnostics[field.id];
                      const val = doc.finalValues[field.id] || diag?.finalValue || '';
                      const isSelected = activeFieldId === field.id;
                      const health = fieldHealth[idx];

                      return (
                        <button
                          type="button"
                          key={field.id}
                          onClick={() => setActiveFieldId(field.id)}
                          aria-pressed={isSelected}
                          className={`rounded-lg border p-3 text-left transition-all ${isSelected
                            ? 'border-neutral-900 bg-neutral-50 ring-2 ring-neutral-900'
                            : health === 'conflict' || health === 'invalid'
                              ? 'border-amber-300 bg-amber-50/50 hover:bg-amber-50'
                              : 'border-neutral-200 hover:bg-neutral-50/60'
                            }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${HEALTH_META[health].dot}`}
                                title={HEALTH_META[health].label}
                              />
                              {field.label || field.name}
                            </span>
                            {isSelected && (
                              <span className="text-[10px] font-bold uppercase text-neutral-900">Selected</span>
                            )}
                          </div>
                          <div className="mt-1 break-words font-mono text-sm font-bold text-neutral-900">
                            {val || <span className="font-normal italic text-neutral-400">Not specified</span>}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {doc.rawExtractedPdfText && (
                    <div className="space-y-1.5 border-t border-neutral-200 pt-4">
                      <span className="block text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                        Raw PDF Digital Content Stream ({doc.pdfTextLength} characters)
                      </span>
                      <pre className="max-h-36 overflow-y-auto whitespace-pre-wrap rounded-md bg-neutral-900 p-3 font-mono text-[11px] leading-relaxed text-neutral-200">
                        {doc.rawExtractedPdfText}
                      </pre>
                    </div>
                  )}

                  <div className="flex items-center justify-between border-t border-neutral-200 pt-4 font-mono text-[10px] text-neutral-400">
                    <span>Extraction Method: {doc.extractionMethodUsed}</span>
                    <span>System Generated Form · Verification Code: 2026-REG-AUTO</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ------------- Right column: diagnostics & review ------------- */}
          <div className="flex min-h-0 w-full shrink-0 flex-col overflow-hidden bg-white md:w-[480px] lg:w-[520px]">
            {/* Field selector */}
            <div className="shrink-0 border-b border-neutral-200 bg-neutral-50/50 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-neutral-600">
                  Fields{' '}
                  <span className="font-normal text-neutral-400">
                    · {fieldIndex + 1} of {profile.fields.length}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (!goToNextIssue()) showFlash('No other fields need attention');
                  }}
                  disabled={attentionCount === 0}
                  className="flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2 py-1 text-[11px] font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
                  title="Jump to the next field that needs attention (N)"
                >
                  <SkipForward className="h-3 w-3" />
                  Next issue
                  <Kbd>N</Kbd>
                </button>
              </div>
              <div
                role="tablist"
                aria-label="Fields"
                className="scrollbar-thin flex gap-1.5 overflow-x-auto pb-1"
              >
                {profile.fields.map((field, idx) => {
                  const health = fieldHealth[idx];
                  const isActive = activeFieldId === field.id;
                  return (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      key={field.id}
                      ref={isActive ? activeChipRef : undefined}
                      onClick={() => setActiveFieldId(field.id)}
                      className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${isActive
                        ? 'bg-neutral-900 text-white shadow-xs'
                        : 'border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-100'
                        }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${HEALTH_META[health].dot}`}
                        title={HEALTH_META[health].label}
                      />
                      <span>{field.name}</span>
                      {field.required && (
                        <span className={isActive ? 'text-white/60' : 'text-rose-500'} title="Required">
                          *
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Scrollable detail panel */}
            <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
              {doc.processingStatus === 'skipped_unassigned' && (
                <div
                  role="status"
                  className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900"
                >
                  <span className="font-semibold">Skipped - no profile assigned: </span>
                  This document was not extracted because no profile could be assigned to it.
                  Assign one, then retry the job. {doc.assignmentReason}
                </div>
              )}
              {doc.processingStatus === 'excluded' && (
                <div
                  role="status"
                  className="rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-3 text-xs text-neutral-700"
                >
                  <span className="font-semibold">Excluded from processing: </span>
                  This document was intentionally skipped, so no fields were extracted for {profile.name}.{' '}
                  {doc.assignmentReason}
                </div>
              )}
              {doc.errorDetails && doc.processingStatus !== 'skipped_unassigned' && (
                <div
                  role="alert"
                  className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900"
                >
                  <span className="font-semibold">Processing warning: </span>
                  {doc.errorDetails}
                </div>
              )}

              {activeField && activeDiagnostic ? (
                <>
                  {/* Final value card */}
                  <section
                    aria-label={`Final value for ${activeField.name}`}
                    className="space-y-3 rounded-lg border border-neutral-200 bg-neutral-50/40 p-4"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-xs font-semibold text-neutral-700">
                        {activeField.label || activeField.name}
                      </h4>
                      {activeDiagnostic.isManuallyCorrected && (
                        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                          Manually corrected
                        </span>
                      )}
                    </div>

                    {isEditing ? (
                      <div className="space-y-2">
                        <input
                          ref={editInputRef}
                          type="text"
                          value={editingValue}
                          onChange={(e) => setEditingValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && isDirty) {
                              e.preventDefault();
                              handleSaveCorrection();
                            }
                          }}
                          aria-label={`Corrected value for ${activeField.name}`}
                          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-sm focus:outline-hidden focus:ring-2 focus:ring-neutral-900"
                          placeholder="Enter corrected value…"
                        />
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] text-neutral-500">
                            <Kbd>Enter</Kbd> to save · <Kbd>Esc</Kbd> to cancel
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={cancelEditing}
                              className="rounded px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-200/60 hover:text-neutral-900"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={handleSaveCorrection}
                              disabled={!isDirty}
                              className="flex items-center gap-1 rounded-md bg-neutral-900 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <Save className="h-3 w-3" />
                              <span>Save value</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start justify-between gap-2">
                        <span className="break-words font-mono text-lg font-semibold leading-snug text-neutral-900">
                          {currentValue || <span className="text-sm font-normal italic text-neutral-400">No value yet</span>}
                        </span>
                        <div className="flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            onClick={handleCopy}
                            disabled={!currentValue}
                            className="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-200/60 hover:text-neutral-900 disabled:opacity-30"
                            title="Copy value"
                            aria-label="Copy value"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={startEditing}
                            className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-200/60 hover:text-neutral-900"
                            title="Edit value (E)"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            Edit
                            <Kbd>E</Kbd>
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Status & explanation */}
                    <div className="space-y-1.5 border-t border-neutral-200/80 pt-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${statusBadgeClass}`}>
                          {activeDiagnostic.status}
                        </span>
                        {activeDiagnostic.confidenceScore !== undefined && (
                          <span className="font-mono text-[11px] text-neutral-500">
                            {Math.round(activeDiagnostic.confidenceScore * 100)}% evidence score
                          </span>
                        )}
                        <span
                          className={`ml-auto flex items-center gap-1 text-[11px] font-semibold ${activeDiagnostic.validationPassed ? 'text-emerald-700' : 'text-rose-700'
                            }`}
                        >
                          {activeDiagnostic.validationPassed ? (
                            <>
                              <CheckCircle2 className="h-3 w-3" /> Validation passed
                            </>
                          ) : (
                            <>
                              <AlertCircle className="h-3 w-3" /> {activeDiagnostic.validationError || 'Validation failed'}
                            </>
                          )}
                        </span>
                      </div>
                      <p className="text-xs leading-relaxed text-neutral-600">{activeDiagnostic.explanation}</p>
                      {activeDiagnostic.selectionReason && (
                        <p className="text-[11px] leading-relaxed text-neutral-500">
                          Why this value: {activeDiagnostic.selectionReason}
                        </p>
                      )}
                    </div>
                  </section>

                  {/* Sources */}
                  <section aria-label="Extraction sources" className="space-y-2">
                    <div className="flex items-baseline justify-between">
                      <h4 className="text-xs font-semibold text-neutral-700">Compare sources</h4>
                      <span className="text-[11px] text-neutral-400">Pick the value that matches the PDF</span>
                    </div>
                    <div className="overflow-hidden rounded-lg border border-neutral-200 text-xs">
                      {numberedRows.map(({ key, ...row }) => (
                        <SourceRow
                          key={key}
                          {...row}
                          isCurrent={Boolean(row.value) && row.value === currentValue}
                          onUse={() => row.value && handleQuickAccept(row.value)}
                        />
                      ))}
                    </div>
                  </section>

                  {/* Context text */}
                  {activeDiagnostic.supportingEvidence && (
                    <section className="space-y-1.5">
                      <h4 className="text-xs font-semibold text-neutral-700">
                        Text around the match (page {activeDiagnostic.pageNumber || 1})
                      </h4>
                      <div className="max-h-36 overflow-y-auto whitespace-pre-wrap rounded-lg bg-neutral-900 p-3 font-mono text-xs leading-relaxed text-neutral-200">
                        {activeDiagnostic.supportingEvidence}
                      </div>
                    </section>
                  )}

                  {/* Rules (secondary) */}
                  <Collapsible title={`Extraction rules for ${activeField.name}`}>
                    <div className="grid grid-cols-2 gap-3 text-xs text-neutral-600">
                      <div>
                        <span className="block text-[11px] text-neutral-400">Priority</span>
                        <span className="font-medium text-neutral-800">{activeField.priority.replace('_', ' ')}</span>
                      </div>
                      <div>
                        <span className="block text-[11px] text-neutral-400">Normalization</span>
                        <span className="font-medium text-neutral-800">
                          {activeField.normalization.caseTransform} · Trim
                        </span>
                      </div>
                      <div className="col-span-2">
                        <span className="block text-[11px] text-neutral-400">Validation</span>
                        <span className="font-medium text-neutral-800">
                          {activeField.required ? 'Required' : 'Optional'}
                          {activeField.validation.allowedValues
                            ? ` · [${activeField.validation.allowedValues.join(', ')}]`
                            : ''}
                        </span>
                      </div>
                    </div>
                  </Collapsible>

                  {/* Audit trail (secondary) */}
                  {doc.editHistory && doc.editHistory.length > 0 && (
                    <Collapsible
                      title="Edit history"
                      badge={
                        <span className="rounded-full bg-neutral-100 px-1.5 py-px text-[10px] font-medium text-neutral-600">
                          {doc.editHistory.length}
                        </span>
                      }
                    >
                      <div className="space-y-1.5">
                        {doc.editHistory.map((item, idx) => (
                          <div
                            key={idx}
                            className={`flex items-center justify-between rounded border p-2.5 text-xs ${item.fieldId === activeFieldId
                              ? 'border-neutral-300 bg-neutral-100'
                              : 'border-neutral-200 bg-neutral-50'
                              }`}
                          >
                            <div className="min-w-0 space-y-0.5">
                              <span className="font-medium text-neutral-800">
                                {profile.fields.find((f) => f.id === item.fieldId)?.name || item.fieldId}
                              </span>
                              <div className="flex items-center gap-1.5 font-mono text-[11px] text-neutral-600">
                                <span className="break-all text-neutral-400 line-through">
                                  {item.previousValue || '(empty)'}
                                </span>
                                <ArrowRight className="h-3 w-3 shrink-0 text-neutral-400" />
                                <span className="break-all font-semibold text-neutral-900">{item.newValue}</span>
                              </div>
                            </div>
                            <span className="ml-2 shrink-0 font-mono text-[10px] text-neutral-400">
                              {new Date(item.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                        ))}
                      </div>
                    </Collapsible>
                  )}
                </>
              ) : (
                <div className="py-12 text-center text-xs text-neutral-400">
                  Select a field above to inspect its details.
                </div>
              )}
            </div>

            {/* Action strip */}
            <div className="relative flex shrink-0 items-center justify-between gap-3 border-t border-neutral-200 bg-neutral-50 p-3 text-xs">
              {flash && (
                <div
                  role="status"
                  aria-live="polite"
                  className="absolute -top-10 left-1/2 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full bg-neutral-900 px-3 py-1.5 text-[11px] font-medium text-white shadow-lg"
                >
                  <Check className="h-3 w-3 text-emerald-400" />
                  {flash}
                </div>
              )}

              <label className="flex cursor-pointer select-none items-center gap-2 text-neutral-600">
                <input
                  type="checkbox"
                  checked={autoAdvance}
                  onChange={(e) => setAutoAdvance(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-neutral-300 accent-neutral-900"
                />
                <span title="After saving or picking a value, jump to the next field that needs attention">
                  Auto-advance
                </span>
              </label>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={fieldIndex <= 0}
                  onClick={() => goToField(fieldIndex - 1)}
                  className="flex items-center gap-1.5 rounded border border-neutral-200 bg-white px-2.5 py-1 hover:bg-neutral-100 disabled:opacity-30"
                  title="Previous field (K)"
                >
                  <ChevronLeft className="h-3 w-3" />
                  Previous
                  <Kbd>K</Kbd>
                </button>
                <button
                  type="button"
                  disabled={fieldIndex >= profile.fields.length - 1}
                  onClick={() => goToField(fieldIndex + 1)}
                  className="flex items-center gap-1.5 rounded border border-neutral-200 bg-white px-2.5 py-1 hover:bg-neutral-100 disabled:opacity-30"
                  title="Next field (J)"
                >
                  Next
                  <ChevronRight className="h-3 w-3" />
                  <Kbd>J</Kbd>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};