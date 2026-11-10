/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Search,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Eye,
  Download,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Check,
  Sparkles,
  ChevronRight,
  RefreshCw,
  XCircle,
  X,
  Pencil,
  Rows3,
  Rows4,
  Keyboard,
} from 'lucide-react';
import {
  ProcessingJob,
  ExtractionProfile,
  PDFDocumentRecord,
  FieldDiagnostic,
  FieldDefinition,
} from '../../types/extraction';

interface ResultsTableViewProps {
  job: ProcessingJob;
  profiles: ExtractionProfile[];
  onInspectDocument: (doc: PDFDocumentRecord) => void;
  onToggleReviewed: (docId: string) => void;
  onUpdateFieldValue: (docId: string, fieldId: string, newValue: string) => void;
  onOpenExport: () => void;
  onCancelJob: () => void;
  onRetryJob: () => void;
}

type FilterCategory = 'all' | 'review' | 'conflicts' | 'missing' | 'invalid' | 'reviewed';

type ProfileFilter = 'all' | string;

interface FieldQualityMetric {
  fieldId: string;
  name: string;
  documents: number;
  extracted: number;
  valid: number;
  invalid: number;
  missing: number;
  conflicts: number;
  corrected: number;
  validityRate: number | null;
}

const FILTER_TABS: { id: FilterCategory; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'review', label: 'Needs review' },
  { id: 'conflicts', label: 'Conflicts' },
  { id: 'missing', label: 'Missing required' },
  { id: 'invalid', label: 'Invalid' },
  { id: 'reviewed', label: 'Reviewed' },
];

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['/'], label: 'Search' },
  { keys: ['J', 'K'], label: 'Next / previous row' },
  { keys: ['Enter'], label: 'Inspect selected row' },
  { keys: ['R'], label: 'Mark selected row reviewed' },
  { keys: ['Enter', 'Tab'], label: 'While editing: save and move down / right' },
  { keys: ['Esc'], label: 'Cancel edit or clear search' },
];

const isTypingTarget = (el: EventTarget | null) => {
  const node = el as HTMLElement | null;
  if (!node || !node.tagName) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
};

const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd className="inline-flex min-w-[1.25rem] items-center justify-center rounded border border-neutral-300 bg-white px-1 py-px font-mono text-[10px] font-semibold leading-none text-neutral-600">
    {children}
  </kbd>
);

/* -------------------------------------------------------------------------- */
/*  KPI tile                                                                  */
/* -------------------------------------------------------------------------- */

type TileTone = 'neutral' | 'emerald' | 'amber' | 'rose' | 'purple' | 'sky' | 'blue';

const TILE_TONES: Record<TileTone, { box: string; label: string; value: string; active: string }> = {
  neutral: {
    box: 'bg-neutral-50 border-neutral-200/70',
    label: 'text-neutral-500',
    value: 'text-neutral-900',
    active: 'ring-neutral-900',
  },
  emerald: {
    box: 'bg-emerald-50/60 border-emerald-200/60',
    label: 'text-emerald-800',
    value: 'text-emerald-900',
    active: 'ring-emerald-700',
  },
  amber: {
    box: 'bg-amber-50/60 border-amber-200/60',
    label: 'text-amber-800',
    value: 'text-amber-900',
    active: 'ring-amber-700',
  },
  rose: {
    box: 'bg-rose-50/60 border-rose-200/60',
    label: 'text-rose-800',
    value: 'text-rose-900',
    active: 'ring-rose-700',
  },
  purple: {
    box: 'bg-purple-50/60 border-purple-200/60',
    label: 'text-purple-800',
    value: 'text-purple-900',
    active: 'ring-purple-700',
  },
  sky: {
    box: 'bg-sky-50/60 border-sky-200/60',
    label: 'text-sky-800',
    value: 'text-sky-900',
    active: 'ring-sky-700',
  },
  blue: {
    box: 'bg-blue-50/60 border-blue-200/60',
    label: 'text-blue-800',
    value: 'text-blue-900',
    active: 'ring-blue-700',
  },
};

const KpiTile: React.FC<{
  label: string;
  value: number;
  hint?: string;
  tone?: TileTone;
  active?: boolean;
  onClick?: () => void;
}> = ({ label, value, hint, tone = 'neutral', active, onClick }) => {
  const t = TILE_TONES[tone];
  const content = (
    <>
      <span className={`block text-[11px] font-medium ${t.label}`}>{label}</span>
      <span className={`font-mono text-lg font-bold tabular-nums ${t.value}`}>{value}</span>
      {hint && <span className={`ml-1 text-[10px] ${t.label} opacity-70`}>{hint}</span>}
    </>
  );
  const base = `rounded-lg border p-2.5 text-left ${t.box}`;
  if (!onClick) return <div className={base}>{content}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={active ? 'Click to clear this filter' : 'Click to filter the table'}
      className={`${base} transition-shadow hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 ${active ? `ring-2 ${t.active}` : ''
        }`}
    >
      {content}
    </button>
  );
};

/* -------------------------------------------------------------------------- */
/*  Main component                                                            */
/* -------------------------------------------------------------------------- */

export const ResultsTableView: React.FC<ResultsTableViewProps> = ({
  job,
  profiles,
  onInspectDocument,
  onToggleReviewed,
  onUpdateFieldValue,
  onOpenExport,
  onCancelJob,
  onRetryJob,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<FilterCategory>('all');
  const [sortField, setSortField] = useState<string>('filename');
  const [sortAsc, setSortAsc] = useState<boolean>(true);
  const [profileFilter, setProfileFilter] = useState<ProfileFilter>('all');
  const [showFieldQuality, setShowFieldQuality] = useState(false);

  // Inline quick-editing state: { docId, fieldId }
  const [editingCell, setEditingCell] = useState<{ docId: string; fieldId: string } | null>(null);
  const [inlineValue, setInlineValue] = useState<string>('');

  // Review-flow UX state
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [compact, setCompact] = useState<boolean>(false);
  const [showShortcuts, setShowShortcuts] = useState<boolean>(false);
  const [flash, setFlash] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const editingCellRef = useRef(editingCell);
  editingCellRef.current = editingCell;

  // Profile filter options: 'All Profiles' (union) plus each individual profile
  const profileOptions = useMemo(
    () => [
      { id: 'all', name: 'All Profiles' },
      ...profiles.map((p) => ({ id: p.id, name: p.name })),
    ],
    [profiles]
  );

  // The single profile selected in the filter, or null when 'All Profiles' is active
  const activeProfile = useMemo(
    () => (profileFilter === 'all' ? null : profiles.find((p) => p.id === profileFilter) || null),
    [profiles, profileFilter]
  );

  // Active field columns based on the profile filter.
  // 'All Profiles' -> union of every field across all profiles (deduped by id, first-seen order)
  // Single profile -> only that profile's fields
  const activeFields = useMemo<FieldDefinition[]>(() => {
    if (activeProfile) {
      return activeProfile.fields;
    }
    const seen = new Set<string>();
    const fields: FieldDefinition[] = [];
    for (const p of profiles) {
      for (const f of p.fields) {
        if (!seen.has(f.id)) {
          seen.add(f.id);
          fields.push(f);
        }
      }
    }
    return fields;
  }, [profiles, activeProfile]);

  // Get the ExtractionProfile assigned to a specific document. The document's
  // own assignment wins; the job-level default is only the fallback the
  // pipeline itself uses. Never invent a profile: an unresolved document must
  // read as unassigned instead of borrowing an unrelated one.
  const getDocProfile = (doc: PDFDocumentRecord) =>
    profiles.find((p) => p.id === doc.profileId) ||
    profiles.find((p) => p.id === job.profileId) ||
    null;

  // Get the field definitions applicable to a document (from its own assigned profile)
  const getDocFields = (doc: PDFDocumentRecord) => {
    const p = getDocProfile(doc);
    return p ? p.fields : [];
  };

  // Calculate high-level summary metrics across the documents.
  // Each document is evaluated against its own assigned profile's field config.
  const summaryMetrics = useMemo(() => {
    let totalDocs = job.documents.length;
    let completed = 0;
    let errors = 0;
    let queued = 0;
    let excluded = 0;
    let reviewRequired = 0;
    let conflicts = 0;
    let missingFields = 0;
    let invalidFields = 0;
    let ocrUsed = 0;
    let aiUsed = 0;

    for (const doc of job.documents) {
      // Queued / in-flight docs have no results yet; exclude them from every
      // quality KPI so a partially-processed batch doesn't report them as
      // "needs review" or "missing".
      if (
        doc.processingStatus === 'pending' ||
        doc.processingStatus === 'processing'
      ) {
        queued++;
        continue;
      }
      if (doc.processingStatus === 'failed') {
        errors++;
        continue;
      }
      // Excluded documents were never extracted, so they belong to no quality
      // KPI and are not counted as processed.
      if (doc.processingStatus === 'excluded') {
        excluded++;
        continue;
      }
      completed++;
      if (!doc.isReviewed) reviewRequired++;
      if (doc.extractionMethodUsed === 'OCR_EXTRACTED') ocrUsed++;
      if (doc.extractionMethodUsed === 'AI_EXTRACTED') aiUsed++;

      // Use this document's own assigned profile for field config
      const docFields = getDocFields(doc);
      for (const field of docFields) {
        const diag = doc.diagnostics[field.id];
        if (!diag) continue;
        if (diag.isConflict) conflicts++;
        if (diag.status === 'NOT_FOUND' && field.required) missingFields++;
        if (diag.status === 'INVALID') invalidFields++;
      }
    }

    return {
      totalDocs,
      completed,
      errors,
      queued,
      excluded,
      reviewRequired,
      conflicts,
      missingFields,
      invalidFields,
      ocrUsed,
      aiUsed,
    };
  }, [job.documents, profiles]);

  const reviewedCount = useMemo(
    () => job.documents.filter((d) => d.isReviewed).length,
    [job.documents]
  );

  // Documents a retry would re-queue server-side: failures plus anything a
  // cooperative cancel left pending (user-excluded docs stay excluded).
  const retryableCount = useMemo(
    () =>
      job.documents.filter(
        (doc) =>
          doc.processingStatus === 'failed' ||
          (doc.processingStatus === 'pending' &&
            doc.assignmentStatus !== 'excluded')
      ).length,
    [job.documents]
  );
  const canRetry =
    job.status !== 'running' && job.status !== 'idle' && retryableCount > 0;

  // Per-field quality across the processed documents of this batch. "Valid"
  // means the value passed the field's own validators; it is a validation pass
  // rate, not a ground-truth precision measurement.
  const fieldQualityMetrics = useMemo<FieldQualityMetric[]>(() => {
    const metrics = new Map<string, FieldQualityMetric>();
    for (const field of activeFields) {
      metrics.set(field.id, {
        fieldId: field.id,
        name: field.name,
        documents: 0,
        extracted: 0,
        valid: 0,
        invalid: 0,
        missing: 0,
        conflicts: 0,
        corrected: 0,
        validityRate: null,
      });
    }
    for (const doc of job.documents) {
      if (doc.processingStatus !== 'completed') continue;
      for (const field of getDocFields(doc)) {
        const metric = metrics.get(field.id);
        const diag = doc.diagnostics[field.id];
        if (!metric || !diag) continue;
        metric.documents += 1;
        const value = doc.finalValues[field.id] ?? diag.finalValue ?? '';
        if (String(value).trim()) {
          metric.extracted += 1;
          const fullyValid =
            diag.validationPassed &&
            !['INVALID', 'MISMATCH', 'AMBIGUOUS', 'REVIEW_REQUIRED'].includes(diag.status);
          if (fullyValid) metric.valid += 1;
        }
        if (diag.status === 'INVALID') metric.invalid += 1;
        if (diag.status === 'NOT_FOUND') metric.missing += 1;
        if (diag.isConflict) metric.conflicts += 1;
        if (diag.isManuallyCorrected) metric.corrected += 1;
      }
    }
    return activeFields.map((field) => {
      const metric = metrics.get(field.id)!;
      metric.validityRate =
        metric.extracted > 0 ? metric.valid / metric.extracted : null;
      return metric;
    });
  }, [job.documents, activeFields, profiles]);

  // Category predicate shared by the table filter and the tab counts, so the
  // number on a tab always equals the rows you get when you click it.
  const matchesCategory = (doc: PDFDocumentRecord, category: FilterCategory): boolean => {
    // Queued / in-flight docs only belong in the "All" view; they have no
    // results yet, so exclude them from every quality-based filter tab.
    if (
      category !== 'all' &&
      (doc.processingStatus === 'pending' ||
        doc.processingStatus === 'processing' ||
        doc.processingStatus === 'excluded')
    ) {
      return false;
    }
    if (category === 'review') {
      const hasFieldNeedingReview = Object.values(doc.diagnostics).some(
        (d) => d.reviewRequired || d.isConflict || d.status === 'INVALID'
      );
      return !doc.isReviewed || hasFieldNeedingReview;
    }
    if (category === 'conflicts') {
      return Object.values(doc.diagnostics).some((d) => d.isConflict);
    }
    if (category === 'missing') {
      return Object.values(doc.diagnostics).some(
        (d) =>
          d.status === 'NOT_FOUND' &&
          getDocFields(doc).find((f) => f.id === d.fieldId)?.required
      );
    }
    if (category === 'invalid') {
      return Object.values(doc.diagnostics).some((d) => d.status === 'INVALID');
    }
    if (category === 'reviewed') {
      return doc.isReviewed;
    }
    return true;
  };

  const filterCounts = useMemo(() => {
    const counts: Record<FilterCategory, number> = {
      all: 0,
      review: 0,
      conflicts: 0,
      missing: 0,
      invalid: 0,
      reviewed: 0,
    };
    for (const doc of job.documents) {
      for (const tab of FILTER_TABS) {
        if (matchesCategory(doc, tab.id)) counts[tab.id] += 1;
      }
    }
    return counts;
  }, [job.documents, profiles]);

  // Filter documents
  const filteredDocuments = useMemo(() => {
    return job.documents.filter((doc) => {
      // 1. Text Search across filename, relative path, and field values
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const matchesFilename = doc.filename.toLowerCase().includes(query);
        const matchesPath = doc.relativePath.toLowerCase().includes(query);
        const matchesValues = Object.values(doc.finalValues).some((val) =>
          val.toLowerCase().includes(query)
        );
        if (!matchesFilename && !matchesPath && !matchesValues) {
          return false;
        }
      }

      // 2. Category Tab Filter
      return matchesCategory(doc, activeFilter);
    });
  }, [job.documents, searchQuery, activeFilter, profiles]);

  // Sort documents
  const sortedDocuments = useMemo(() => {
    return [...filteredDocuments].sort((a, b) => {
      let valA = '';
      let valB = '';

      if (sortField === 'filename') {
        valA = a.filename;
        valB = b.filename;
      } else if (sortField === 'path') {
        valA = a.relativePath;
        valB = b.relativePath;
      } else if (sortField === 'profile') {
        valA = getDocProfile(a)?.name || '';
        valB = getDocProfile(b)?.name || '';
      } else {
        valA = a.finalValues[sortField] || '';
        valB = b.finalValues[sortField] || '';
      }

      const cmp = valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' });
      return sortAsc ? cmp : -cmp;
    });
  }, [filteredDocuments, sortField, sortAsc, profiles]);

  const hasActiveFilters = activeFilter !== 'all' || searchQuery.trim() !== '';

  const clearFilters = () => {
    setActiveFilter('all');
    setSearchQuery('');
  };

  const showFlash = (message: string) => {
    setFlash(message);
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlash(null), 2400);
  };

  useEffect(
    () => () => {
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    },
    []
  );

  const handleSort = (fieldId: string) => {
    if (sortField === fieldId) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(fieldId);
      setSortAsc(true);
    }
  };

  /* ---------------------------- Inline editing ---------------------------- */

  const isEditableDoc = (doc: PDFDocumentRecord) =>
    doc.processingStatus !== 'pending' &&
    doc.processingStatus !== 'processing' &&
    doc.processingStatus !== 'excluded';

  const getCellValue = (doc: PDFDocumentRecord, fieldId: string) =>
    doc.finalValues[fieldId] || doc.diagnostics[fieldId]?.finalValue || '';

  const startInlineEdit = (docId: string, fieldId: string, currentValue: string) => {
    setEditingCell({ docId, fieldId });
    setInlineValue(currentValue);
    setSelectedDocId(docId);
  };

  /**
   * Ends the active inline edit. `move` chains straight into the next cell so a
   * reviewer can fix a whole column (Enter) or row (Tab) without the mouse.
   */
  const finishInlineEdit = (save: boolean, move?: 'down' | 'next' | 'prev') => {
    if (!editingCell) return;
    const { docId, fieldId } = editingCell;
    const rowIdx = sortedDocuments.findIndex((d) => d.id === docId);
    const doc = rowIdx >= 0 ? sortedDocuments[rowIdx] : undefined;

    if (save && doc && inlineValue !== getCellValue(doc, fieldId)) {
      onUpdateFieldValue(docId, fieldId, inlineValue);
    }

    if (move && rowIdx >= 0) {
      const colIdx = activeFields.findIndex((f) => f.id === fieldId);
      let target: { doc: PDFDocumentRecord; fieldId: string } | null = null;

      if (move === 'down') {
        for (let i = rowIdx + 1; i < sortedDocuments.length; i++) {
          if (isEditableDoc(sortedDocuments[i])) {
            target = { doc: sortedDocuments[i], fieldId };
            break;
          }
        }
      } else {
        const dir = move === 'next' ? 1 : -1;
        let r = rowIdx;
        let c = colIdx + dir;
        while (r >= 0 && r < sortedDocuments.length) {
          if (c >= activeFields.length) {
            r += 1;
            c = 0;
          } else if (c < 0) {
            r -= 1;
            c = activeFields.length - 1;
          }
          if (r < 0 || r >= sortedDocuments.length) break;
          if (isEditableDoc(sortedDocuments[r])) {
            target = { doc: sortedDocuments[r], fieldId: activeFields[c].id };
            break;
          }
          c += dir;
        }
      }

      if (target) {
        startInlineEdit(target.doc.id, target.fieldId, getCellValue(target.doc, target.fieldId));
        return;
      }
    }
    setEditingCell(null);
  };

  const batchEligible = filteredDocuments.filter(
    (doc) => !doc.isReviewed && doc.processingStatus !== 'excluded'
  );

  const handleBatchMarkReviewed = () => {
    if (batchEligible.length >= 5) {
      const ok = window.confirm(
        `Mark ${batchEligible.length} documents as reviewed? This applies to the documents currently shown.`
      );
      if (!ok) return;
    }
    const count = batchEligible.length;
    for (const doc of filteredDocuments) {
      if (!doc.isReviewed && doc.processingStatus !== 'excluded') {
        onToggleReviewed(doc.id);
      }
    }
    if (count > 0) showFlash(`Marked ${count} document${count === 1 ? '' : 's'} as reviewed`);
  };

  /* --------------------------- Keyboard shortcuts -------------------------- */

  const moveSelection = (delta: 1 | -1) => {
    if (sortedDocuments.length === 0) return;
    const idx = sortedDocuments.findIndex((d) => d.id === selectedDocId);
    const next =
      idx === -1
        ? delta === 1
          ? 0
          : sortedDocuments.length - 1
        : Math.min(sortedDocuments.length - 1, Math.max(0, idx + delta));
    setSelectedDocId(sortedDocuments[next].id);
  };

  // Latest-closure pattern: one stable listener always sees fresh state.
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyHandlerRef.current = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // The document inspector has its own shortcuts; stay out of its way.
    if (window.document.querySelector('[role="dialog"][aria-modal="true"]')) return;
    if (isTypingTarget(e.target)) return;

    const key = e.key.toLowerCase();
    const selected = sortedDocuments.find((d) => d.id === selectedDocId);

    switch (key) {
      case '/':
        e.preventDefault();
        searchRef.current?.focus();
        break;
      case 'j':
      case 'arrowdown':
        e.preventDefault();
        moveSelection(1);
        break;
      case 'k':
      case 'arrowup':
        e.preventDefault();
        moveSelection(-1);
        break;
      case 'enter':
        if (selected) {
          e.preventDefault();
          onInspectDocument(selected);
        }
        break;
      case 'r':
        if (selected) {
          e.preventDefault();
          onToggleReviewed(selected.id);
        }
        break;
      case 'escape':
        setSelectedDocId(null);
        setShowShortcuts(false);
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

  // Keep the keyboard-selected row visible.
  useEffect(() => {
    if (!selectedDocId || !tableScrollRef.current) return;
    const el = tableScrollRef.current.querySelector(
      `[data-doc-id="${CSS.escape(selectedDocId)}"]`
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedDocId]);

  /* ------------------------------ Row status ------------------------------ */

  const renderStatus = (doc: PDFDocumentRecord) => {
    const diagnostics = Object.values(doc.diagnostics);
    const hasConflict = diagnostics.some((d) => d.isConflict);
    const invalidDiagnostics = diagnostics.filter((d) => d.status === 'INVALID');
    const hasInvalid = invalidDiagnostics.length > 0;
    const invalidTooltip = invalidDiagnostics
      .map((d) => `${d.fieldName || d.fieldId}: ${d.validationError || 'Validation failed'}`)
      .join('\n');
    const isPending = doc.processingStatus === 'pending' || doc.processingStatus === 'processing';
    const isExcluded = doc.processingStatus === 'excluded';
    const hasMissingRequired = diagnostics.some(
      (d) =>
        d.status === 'NOT_FOUND' &&
        getDocFields(doc).find((f) => f.id === d.fieldId)?.required
    );
    const isAi = doc.extractionMethodUsed === 'AI_EXTRACTED';
    const isOcrOrAi = doc.extractionMethodUsed === 'OCR_EXTRACTED' || isAi;

    let title: string;
    let icon: React.ReactNode;

    if (isPending) {
      title = doc.processingStatus === 'processing' ? 'Processing...' : 'Queued for processing';
      icon = (
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full border-2 ${doc.processingStatus === 'processing'
              ? 'animate-spin border-neutral-300 border-t-neutral-700 motion-reduce:animate-none'
              : 'border-neutral-200'
            }`}
        />
      );
    } else if (isExcluded) {
      title = 'Excluded from processing by the user';
      icon = <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-dashed border-neutral-400" />;
    } else if (doc.errorDetails) {
      title = `Processing warning: ${doc.errorDetails}`;
      icon = <AlertTriangle className="h-4 w-4 text-amber-600" />;
    } else if (hasInvalid) {
      title = `Invalid values hidden from export:\n${invalidTooltip}`;
      icon = <AlertCircle className="h-4 w-4 text-rose-600" />;
    } else if (doc.isReviewed) {
      title = 'Reviewed and verified';
      icon = <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
    } else if (hasConflict) {
      title = 'Conflict detected between filename and PDF';
      icon = <AlertTriangle className="h-4 w-4 text-amber-500" />;
    } else if (hasMissingRequired) {
      title = 'Missing required fields';
      icon = <AlertCircle className="h-4 w-4 text-rose-500" />;
    } else if (isOcrOrAi) {
      title = isAi ? 'Local AI-assisted extraction; verify values' : 'Extracted via OCR fallback';
      icon = <Sparkles className={`h-4 w-4 ${isAi ? 'text-sky-700' : 'text-purple-600'}`} />;
    } else {
      title = 'Ready for review';
      icon = <Check className="h-3.5 w-3.5 text-neutral-400" />;
    }

    return (
      <span title={title} className="inline-flex items-center justify-center" role="img" aria-label={title.split('\n')[0]}>
        {icon}
      </span>
    );
  };

  /* -------------------------------- Render -------------------------------- */

  const cellPad = compact ? 'py-1 px-3' : 'py-2.5 px-3';

  const SortHeader: React.FC<{
    id: string;
    label: string;
    className?: string;
    stickyClass?: string;
  }> = ({ id, label, className = '', stickyClass = '' }) => {
    const active = sortField === id;
    return (
      <th
        scope="col"
        aria-sort={active ? (sortAsc ? 'ascending' : 'descending') : 'none'}
        className={`sticky top-0 z-20 border-b border-neutral-200 bg-neutral-50 px-0 ${stickyClass} ${className}`}
      >
        <button
          type="button"
          onClick={() => handleSort(id)}
          className={`flex w-full items-center gap-1.5 whitespace-nowrap px-3 py-2.5 text-left font-semibold transition-colors hover:text-neutral-900 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-900 ${active ? 'text-neutral-900' : 'text-neutral-600'
            }`}
        >
          <span>{label}</span>
          {active ? (
            sortAsc ? (
              <ArrowUp className="h-3 w-3 text-neutral-900" />
            ) : (
              <ArrowDown className="h-3 w-3 text-neutral-900" />
            )
          ) : (
            <ArrowUpDown className="h-3 w-3 text-neutral-300" />
          )}
        </button>
      </th>
    );
  };

  const reviewProgress =
    summaryMetrics.completed > 0
      ? Math.min(100, Math.round((reviewedCount / summaryMetrics.completed) * 100))
      : 0;

  return (
    <div className="space-y-5">
      {/* 1. Summary & actions */}
      <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-xs">
        <div className="flex flex-col justify-between gap-4 border-b border-neutral-100 pb-4 md:flex-row md:items-start">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-lg font-bold text-neutral-900">Extraction &amp; Reconciliation Results</h2>
              <span className="truncate font-mono text-xs text-neutral-500" title={job.zipFilename}>
                Batch: {job.zipFilename}
              </span>
            </div>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500">
              <span>
                {summaryMetrics.completed} of {job.totalDiscovered || job.documents.length} processed
              </span>
              {summaryMetrics.excluded > 0 && (
                <span>· {summaryMetrics.excluded} excluded from processing</span>
              )}
              {summaryMetrics.errors > 0 && (
                <span className="font-medium text-rose-700">· {summaryMetrics.errors} failed</span>
              )}
              {job.status === 'running' && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                  <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-emerald-300 border-t-emerald-700 motion-reduce:animate-none" />
                  Live — {summaryMetrics.queued} still queued
                </span>
              )}
            </p>

            {/* Review progress */}
            <div className="flex items-center gap-3" title={`${reviewedCount} of ${summaryMetrics.completed} processed documents reviewed`}>
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={reviewProgress}
                aria-label="Review progress"
                className="h-1.5 w-48 overflow-hidden rounded-full bg-neutral-100"
              >
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all"
                  style={{ width: `${reviewProgress}%` }}
                />
              </div>
              <span className="font-mono text-[11px] tabular-nums text-neutral-500">
                {reviewedCount} / {summaryMetrics.completed} reviewed
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {job.status === 'running' && (
              <button
                type="button"
                onClick={onCancelJob}
                disabled={job.cancelRequested}
                title={
                  job.cancelRequested
                    ? 'Waiting for the documents currently being extracted to finish'
                    : 'Stop after the documents currently being extracted finish; the rest stay pending'
                }
                className="flex items-center gap-1.5 rounded-md border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <XCircle className="h-3.5 w-3.5" />
                <span>{job.cancelRequested ? 'Cancelling…' : 'Cancel job'}</span>
              </button>
            )}
            {canRetry && (
              <button
                type="button"
                onClick={onRetryJob}
                title="Re-queue failed documents and anything a cancel left pending"
                className="flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>Retry ({retryableCount})</span>
              </button>
            )}
            <button
              type="button"
              onClick={handleBatchMarkReviewed}
              disabled={batchEligible.length === 0}
              title={
                batchEligible.length === 0
                  ? 'Every document currently shown is already reviewed'
                  : 'Mark every unreviewed document currently shown as reviewed'
              }
              className="flex items-center gap-1.5 rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Check className="h-3.5 w-3.5" />
              <span>Mark {batchEligible.length} shown as reviewed</span>
            </button>
            <button
              type="button"
              onClick={onOpenExport}
              className="flex items-center gap-1.5 rounded-md bg-neutral-900 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-800"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export CSV</span>
            </button>
          </div>
        </div>

        {/* KPI tiles: those with a filter are clickable shortcuts into the table */}
        <div className="grid grid-cols-2 gap-3 pt-4 sm:grid-cols-3 lg:grid-cols-5">
          <KpiTile label="Total documents" value={summaryMetrics.totalDocs} onClick={() => setActiveFilter('all')} active={activeFilter === 'all'} />
          <KpiTile label="Processed" value={summaryMetrics.completed} tone="emerald" />
          <KpiTile label="Queued" value={summaryMetrics.queued} />
          <KpiTile
            label="Needs review"
            value={summaryMetrics.reviewRequired}
            onClick={() => setActiveFilter(activeFilter === 'review' ? 'all' : 'review')}
            active={activeFilter === 'review'}
          />
          <KpiTile
            label="Reviewed"
            value={reviewedCount}
            tone="blue"
            onClick={() => setActiveFilter(activeFilter === 'reviewed' ? 'all' : 'reviewed')}
            active={activeFilter === 'reviewed'}
          />
          <KpiTile
            label="Conflicts flagged"
            value={summaryMetrics.conflicts}
            hint="fields"
            tone="amber"
            onClick={() => setActiveFilter(activeFilter === 'conflicts' ? 'all' : 'conflicts')}
            active={activeFilter === 'conflicts'}
          />
          <KpiTile
            label="Missing fields"
            value={summaryMetrics.missingFields}
            hint="required"
            tone="rose"
            onClick={() => setActiveFilter(activeFilter === 'missing' ? 'all' : 'missing')}
            active={activeFilter === 'missing'}
          />
          <KpiTile
            label="Invalid values"
            value={summaryMetrics.invalidFields}
            hint="fields"
            tone="rose"
            onClick={() => setActiveFilter(activeFilter === 'invalid' ? 'all' : 'invalid')}
            active={activeFilter === 'invalid'}
          />
          <KpiTile label="OCR fallbacks" value={summaryMetrics.ocrUsed} tone="purple" />
          <KpiTile label="AI-assisted" value={summaryMetrics.aiUsed} tone="sky" />
        </div>
      </div>

      {/* 1b. Per-field quality */}
      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xs">
        <button
          type="button"
          onClick={() => setShowFieldQuality((current) => !current)}
          aria-expanded={showFieldQuality}
          className="flex w-full items-center justify-between px-5 py-3 text-left transition-colors hover:bg-neutral-50/70"
        >
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-bold text-neutral-900">Per-field quality</span>
            <span className="text-[11px] text-neutral-500">Validation pass rate across processed documents</span>
          </div>
          <ChevronRight
            className={`h-4 w-4 text-neutral-500 transition-transform ${showFieldQuality ? 'rotate-90' : ''}`}
          />
        </button>
        {showFieldQuality && (
          <div className="overflow-x-auto border-t border-neutral-100 px-5 pb-4 pt-3">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="text-[11px] text-neutral-400">
                  <th className="py-1.5 pr-3 font-medium">Field</th>
                  <th className="px-2 py-1.5 text-right font-medium">Docs</th>
                  <th className="px-2 py-1.5 text-right font-medium">Extracted</th>
                  <th className="px-2 py-1.5 text-right font-medium">Valid</th>
                  <th className="px-2 py-1.5 text-right font-medium">Invalid</th>
                  <th className="px-2 py-1.5 text-right font-medium">Missing</th>
                  <th className="px-2 py-1.5 text-right font-medium">Conflicts</th>
                  <th className="px-2 py-1.5 text-right font-medium">Corrected</th>
                  <th className="py-1.5 pl-2 text-right font-medium">Validity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {fieldQualityMetrics.map((metric) => {
                  const rate = metric.validityRate;
                  const tone =
                    rate === null
                      ? 'text-neutral-300'
                      : rate >= 0.95
                        ? 'text-emerald-700'
                        : rate >= 0.8
                          ? 'text-amber-700'
                          : 'text-rose-700';
                  const bar =
                    rate === null
                      ? 'bg-neutral-200'
                      : rate >= 0.95
                        ? 'bg-emerald-500'
                        : rate >= 0.8
                          ? 'bg-amber-500'
                          : 'bg-rose-500';
                  return (
                    <tr key={metric.fieldId}>
                      <td className="whitespace-nowrap py-1.5 pr-3 font-medium text-neutral-800">{metric.name}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-neutral-600">{metric.documents}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-neutral-600">{metric.extracted}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-emerald-700">{metric.valid}</td>
                      <td className={`px-2 py-1.5 text-right font-mono tabular-nums ${metric.invalid ? 'font-semibold text-rose-700' : 'text-neutral-400'}`}>
                        {metric.invalid}
                      </td>
                      <td className={`px-2 py-1.5 text-right font-mono tabular-nums ${metric.missing ? 'text-amber-700' : 'text-neutral-400'}`}>
                        {metric.missing}
                      </td>
                      <td className={`px-2 py-1.5 text-right font-mono tabular-nums ${metric.conflicts ? 'text-amber-700' : 'text-neutral-400'}`}>
                        {metric.conflicts}
                      </td>
                      <td className={`px-2 py-1.5 text-right font-mono tabular-nums ${metric.corrected ? 'text-blue-700' : 'text-neutral-400'}`}>
                        {metric.corrected}
                      </td>
                      <td className="py-1.5 pl-2">
                        <div className="flex items-center justify-end gap-2">
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-neutral-100" aria-hidden>
                            <div className={`h-full ${bar}`} style={{ width: `${Math.round((rate ?? 0) * 100)}%` }} />
                          </div>
                          <span className={`w-9 text-right font-mono font-semibold tabular-nums ${tone}`}>
                            {rate === null ? '—' : `${Math.round(rate * 100)}%`}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] text-neutral-400">
              Validity = values passing field validation ÷ extracted values. It is a rule-based pass rate, not
              ground-truth precision; manual review remains the source of truth.
            </p>
          </div>
        )}
      </div>

      {/* 2. Filters & search */}
      <div className="space-y-2">
        <div className="flex flex-col items-stretch justify-between gap-3 lg:flex-row lg:items-center">
          <div
            role="tablist"
            aria-label="Filter documents"
            className="flex items-center gap-1 overflow-x-auto rounded-lg bg-neutral-100 p-1 text-xs font-medium"
          >
            {FILTER_TABS.map((tab) => {
              const isActive = activeFilter === tab.id;
              return (
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  key={tab.id}
                  onClick={() => setActiveFilter(tab.id)}
                  className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 transition-colors ${isActive
                      ? 'bg-white font-semibold text-neutral-900 shadow-xs'
                      : 'text-neutral-600 hover:text-neutral-900'
                    }`}
                >
                  {tab.label}
                  <span
                    className={`rounded-full px-1.5 py-px font-mono text-[10px] tabular-nums ${isActive ? 'bg-neutral-900 text-white' : 'bg-neutral-200/80 text-neutral-600'
                      }`}
                  >
                    {filterCounts[tab.id]}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-neutral-600">
              <span className="text-neutral-500">Columns</span>
              <select
                value={profileFilter}
                onChange={(e) => setProfileFilter(e.target.value as ProfileFilter)}
                className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-700 focus:outline-hidden focus:ring-2 focus:ring-neutral-900"
                title="Choose which profile's fields are shown as columns"
              >
                {profileOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.id === 'all' ? `All profiles (${profiles.length})` : opt.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-2 h-4 w-4 text-neutral-400" />
              <input
                ref={searchRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    if (searchQuery) setSearchQuery('');
                    else searchRef.current?.blur();
                  }
                }}
                aria-label="Search filenames, paths or values"
                placeholder="Search filenames or values…"
                className="w-full rounded-md border border-neutral-300 bg-white py-1.5 pl-9 pr-14 text-xs focus:outline-hidden focus:ring-2 focus:ring-neutral-900"
              />
              {searchQuery ? (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    searchRef.current?.focus();
                  }}
                  aria-label="Clear search"
                  className="absolute right-2 top-1.5 rounded p-0.5 text-neutral-400 hover:text-neutral-900"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : (
                <span className="pointer-events-none absolute right-2 top-1.5">
                  <Kbd>/</Kbd>
                </span>
              )}
            </div>

            <div className="flex items-center gap-0.5 rounded-md bg-neutral-100 p-0.5">
              <button
                type="button"
                onClick={() => setCompact(false)}
                aria-pressed={!compact}
                aria-label="Comfortable rows"
                title="Comfortable rows"
                className={`rounded p-1.5 ${!compact ? 'bg-white text-neutral-900 shadow-xs' : 'text-neutral-500 hover:text-neutral-900'}`}
              >
                <Rows3 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setCompact(true)}
                aria-pressed={compact}
                aria-label="Compact rows"
                title="Compact rows — more documents on screen"
                className={`rounded p-1.5 ${compact ? 'bg-white text-neutral-900 shadow-xs' : 'text-neutral-500 hover:text-neutral-900'}`}
              >
                <Rows4 className="h-3.5 w-3.5" />
              </button>
            </div>

            <button
              type="button"
              onClick={() => setShowShortcuts((s) => !s)}
              aria-pressed={showShortcuts}
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (?)"
              className="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
            >
              <Keyboard className="h-4 w-4" />
            </button>
          </div>
        </div>

        {showShortcuts && (
          <div
            role="region"
            aria-label="Keyboard shortcuts"
            className="flex flex-wrap gap-x-6 gap-y-1.5 rounded-lg border border-neutral-200 bg-white px-4 py-3 text-xs text-neutral-600"
          >
            {SHORTCUTS.map((s) => (
              <span key={s.label} className="flex items-center gap-2">
                <span className="flex gap-1">
                  {s.keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
                {s.label}
              </span>
            ))}
          </div>
        )}

        {hasActiveFilters && (
          <div className="flex items-center gap-2 text-xs text-neutral-500" role="status">
            <span>
              Showing <span className="font-semibold text-neutral-800">{sortedDocuments.length}</span> of{' '}
              {job.documents.length} documents
            </span>
            <button
              type="button"
              onClick={clearFilters}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-neutral-700 underline-offset-2 hover:bg-neutral-100 hover:underline"
            >
              <X className="h-3 w-3" /> Clear filters
            </button>
          </div>
        )}
      </div>

      {/* 3. Data grid */}
      <div className="relative overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xs">
        {flash && (
          <div
            role="status"
            aria-live="polite"
            className="absolute bottom-14 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full bg-neutral-900 px-3 py-1.5 text-[11px] font-medium text-white shadow-lg"
          >
            <Check className="h-3 w-3 text-emerald-400" />
            {flash}
          </div>
        )}

        <div ref={tableScrollRef} className="max-h-[70vh] overflow-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="select-none">
                <th
                  scope="col"
                  className="sticky left-0 top-0 z-30 w-12 min-w-[3rem] border-b border-neutral-200 bg-neutral-50 px-3 py-2.5 text-center font-semibold text-neutral-600"
                >
                  Status
                </th>
                <SortHeader
                  id="filename"
                  label="Document"
                  stickyClass="left-12 z-30 shadow-[1px_0_0_0_theme(colors.neutral.200)]"
                />
                <SortHeader id="profile" label="Profile" />
                <SortHeader id="path" label="Path" />

                {/* Profile field columns */}
                {activeFields.map((field) => (
                  <SortHeader key={field.id} id={field.id} label={field.name} />
                ))}

                <th
                  scope="col"
                  className="sticky top-0 z-20 whitespace-nowrap border-b border-neutral-200 bg-neutral-50 px-3 py-2.5 text-right font-semibold text-neutral-600"
                >
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {sortedDocuments.length === 0 ? (
                <tr>
                  <td colSpan={activeFields.length + 5} className="py-14 text-center">
                    <p className="text-sm font-medium text-neutral-800">No documents match</p>
                    <p className="mt-1 text-xs text-neutral-500">
                      {hasActiveFilters
                        ? 'Try a different search term or filter.'
                        : 'Documents will appear here as they are processed.'}
                    </p>
                    {hasActiveFilters && (
                      <button
                        type="button"
                        onClick={clearFilters}
                        className="mt-3 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-800 hover:bg-neutral-100"
                      >
                        Clear filters
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
                sortedDocuments.map((doc) => {
                  const docProfile = getDocProfile(doc);
                  const isPending =
                    doc.processingStatus === 'pending' ||
                    doc.processingStatus === 'processing';
                  const isExcluded = doc.processingStatus === 'excluded';
                  const isSelected = selectedDocId === doc.id;
                  const docFields = getDocFields(doc);

                  const stickyBg = isSelected ? 'bg-neutral-100' : 'bg-white group-hover:bg-neutral-50';

                  return (
                    <tr
                      key={doc.id}
                      data-doc-id={doc.id}
                      aria-selected={isSelected}
                      onClick={() => setSelectedDocId(doc.id)}
                      className={`group transition-colors ${isPending || isExcluded ? 'opacity-60' : ''
                        } ${isSelected ? 'bg-neutral-100' : 'hover:bg-neutral-50/70'}`}
                    >
                      {/* Status */}
                      <td className={`sticky left-0 z-10 w-12 min-w-[3rem] text-center ${cellPad} ${stickyBg} ${isSelected ? 'shadow-[inset_3px_0_0_0_theme(colors.neutral.900)]' : ''}`}>
                        {renderStatus(doc)}
                      </td>

                      {/* Filename */}
                      <td
                        className={`sticky left-12 z-10 max-w-xs truncate whitespace-nowrap font-medium text-neutral-900 shadow-[1px_0_0_0_theme(colors.neutral.200)] ${cellPad} ${stickyBg}`}
                      >
                        <button
                          type="button"
                          onClick={() => onInspectDocument(doc)}
                          className="max-w-full truncate text-left hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
                          title={`Inspect ${doc.filename}`}
                        >
                          {doc.filename}
                        </button>
                      </td>

                      {/* Profile */}
                      <td className={`whitespace-nowrap ${cellPad}`}>
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${docProfile ? 'bg-neutral-300' : 'bg-rose-400'}`} />
                          <span
                            className={`max-w-[120px] truncate ${docProfile ? 'text-neutral-700' : 'text-rose-600'}`}
                            title={doc.assignmentReason || undefined}
                          >
                            {docProfile?.name || doc.profileName || 'Unassigned'}
                          </span>
                        </span>
                      </td>

                      {/* Path */}
                      <td
                        className={`max-w-[140px] truncate whitespace-nowrap font-mono text-[11px] text-neutral-500 ${cellPad}`}
                        title={doc.relativePath}
                      >
                        {doc.relativePath}
                      </td>

                      {/* Field value cells */}
                      {activeFields.map((field) => {
                        const diag = doc.diagnostics[field.id];
                        const val = doc.finalValues[field.id] || diag?.finalValue || '';
                        const isConflictCell = diag?.isConflict;
                        const isInvalidCell = diag?.status === 'INVALID';
                        const isFilenameOnlyCell = diag?.status === 'FILENAME_ONLY';
                        const isCorrected = diag?.isManuallyCorrected;
                        const isOcrCell = diag?.source === 'ocr';
                        const isAiCell = diag?.source === 'ai';
                        const isFormCell = diag?.source === 'form_field';

                        // Check if this field belongs to the document's assigned profile
                        const fieldAppliesToDoc = docFields.some((f) => f.id === field.id);

                        const isCurrentlyEditing =
                          editingCell?.docId === doc.id && editingCell?.fieldId === field.id;

                        // Excluded documents were never extracted, so there is
                        // no value to show or edit.
                        if (isExcluded) {
                          return (
                            <td key={field.id} className={`whitespace-nowrap ${cellPad}`}>
                              <span
                                className="text-[11px] italic text-neutral-400"
                                title="Excluded from processing - no extraction was run"
                              >
                                —
                              </span>
                            </td>
                          );
                        }

                        if (isCurrentlyEditing) {
                          return (
                            <td key={field.id} className="whitespace-nowrap px-2 py-1">
                              <input
                                autoFocus
                                type="text"
                                value={inlineValue}
                                aria-label={`Edit ${field.name} for ${doc.filename}`}
                                onChange={(e) => setInlineValue(e.target.value)}
                                onFocus={(e) => e.currentTarget.select()}
                                onBlur={() => {
                                  // Ignore blurs from an input that has already been
                                  // replaced by the next cell's editor.
                                  const live = editingCellRef.current;
                                  if (live?.docId === doc.id && live?.fieldId === field.id) {
                                    finishInlineEdit(true);
                                  }
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    finishInlineEdit(true, e.shiftKey ? undefined : 'down');
                                  } else if (e.key === 'Tab') {
                                    e.preventDefault();
                                    finishInlineEdit(true, e.shiftKey ? 'prev' : 'next');
                                  } else if (e.key === 'Escape') {
                                    e.preventDefault();
                                    finishInlineEdit(false);
                                  }
                                }}
                                className="w-full min-w-[140px] rounded border border-neutral-900 bg-white px-2 py-1 font-mono text-xs focus:outline-hidden focus:ring-2 focus:ring-neutral-900/30"
                              />
                            </td>
                          );
                        }

                        if (isPending) {
                          return (
                            <td key={field.id} className={`whitespace-nowrap ${cellPad}`}>
                              <span className="text-[11px] italic text-neutral-400">
                                {doc.processingStatus === 'processing' ? 'Processing…' : 'Queued'}
                              </span>
                            </td>
                          );
                        }

                        return (
                          <td
                            key={field.id}
                            onDoubleClick={() => startInlineEdit(doc.id, field.id, val)}
                            className={`group/cell whitespace-nowrap ${cellPad}`}
                          >
                            <div className="flex items-center gap-1.5">
                              {val ? (
                                <span
                                  className={`font-mono text-xs ${!fieldAppliesToDoc
                                      ? 'text-neutral-500 opacity-60'
                                      : isConflictCell
                                        ? 'rounded bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-800'
                                        : isInvalidCell
                                          ? 'rounded bg-rose-50 px-1.5 py-0.5 font-semibold text-rose-800'
                                          : isCorrected
                                            ? 'font-medium text-blue-800'
                                            : 'text-neutral-800'
                                    }`}
                                  title={
                                    isInvalidCell
                                      ? diag?.validationError || 'Value failed validation; hidden from export'
                                      : diag?.explanation || val
                                  }
                                >
                                  {val}
                                </span>
                              ) : (
                                <span
                                  className={`text-[11px] italic ${!fieldAppliesToDoc
                                      ? 'text-neutral-400'
                                      : field.required
                                        ? 'font-medium text-rose-500'
                                        : 'text-neutral-400'
                                    }`}
                                  title={
                                    !fieldAppliesToDoc
                                      ? "Field not in this document's assigned profile"
                                      : diag?.explanation || val
                                  }
                                >
                                  {!fieldAppliesToDoc ? 'N/A' : field.required ? 'Missing' : '—'}
                                </span>
                              )}

                              {isConflictCell && (
                                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" title="Conflict between sources" />
                              )}
                              {isInvalidCell && (
                                <span
                                  title={diag?.validationError || 'Value failed validation; hidden from export'}
                                  className="inline-flex shrink-0"
                                >
                                  <AlertCircle className="h-3 w-3 text-rose-600" />
                                </span>
                              )}
                              {isFormCell && (
                                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" title="Filled form-field (AcroForm) value" />
                              )}
                              {isFilenameOnlyCell && (
                                <span
                                  className="h-1.5 w-1.5 shrink-0 rounded-full border border-amber-500 bg-amber-200"
                                  title="Filename-only match; no document-side value existed to cross-check it"
                                />
                              )}
                              {isOcrCell && (
                                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-purple-500" title="OCR extracted" />
                              )}
                              {isAiCell && (
                                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-600" title="Local AI extracted; verify this value" />
                              )}
                              {isCorrected && (
                                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" title="Manually edited" />
                              )}

                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  startInlineEdit(doc.id, field.id, val);
                                }}
                                aria-label={`Edit ${field.name} for ${doc.filename}`}
                                title="Edit value (or double-click)"
                                className="ml-0.5 shrink-0 rounded p-0.5 text-neutral-400 opacity-0 transition-opacity hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:opacity-100 group-hover/cell:opacity-100"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                            </div>
                          </td>
                        );
                      })}

                      {/* Row actions */}
                      <td className={`whitespace-nowrap text-right ${cellPad}`}>
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => onInspectDocument(doc)}
                            className="flex items-center gap-1 rounded px-1.5 py-1 text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
                            title="Inspect PDF and diagnostics"
                            aria-label={`Inspect ${doc.filename}`}
                          >
                            <Eye className="h-3.5 w-3.5" />
                            <span className="text-[11px] font-medium">Inspect</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onToggleReviewed(doc.id)}
                            aria-pressed={doc.isReviewed}
                            aria-label={doc.isReviewed ? 'Mark unreviewed' : 'Mark reviewed'}
                            className={`rounded p-1.5 transition-colors ${doc.isReviewed
                                ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                : 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900'
                              }`}
                            title={doc.isReviewed ? 'Mark unreviewed (R)' : 'Mark reviewed (R)'}
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-neutral-200 bg-neutral-50/60 px-4 py-2.5 text-xs text-neutral-500">
          <span className="font-mono">
            Showing {sortedDocuments.length} of {job.documents.length} documents
          </span>
          <span className="hidden items-center gap-2 sm:flex">
            Double-click a cell to edit · <Kbd>Enter</Kbd> next row · <Kbd>Tab</Kbd> next cell · <Kbd>J</Kbd>
            <Kbd>K</Kbd> move · <Kbd>?</Kbd> all shortcuts
          </span>
        </div>
      </div>
    </div>
  );
};