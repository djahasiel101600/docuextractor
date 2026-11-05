/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from 'react';
import {
  Search,
  Filter,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Eye,
  Download,
  ArrowUpDown,
  Check,
  RotateCcw,
  Sparkles,
  ChevronRight,
  FileText,
  SlidersHorizontal,
} from 'lucide-react';
import {
  ProcessingJob,
  ExtractionProfile,
  PDFDocumentRecord,
  FieldDiagnostic,
} from '../../types/extraction';

interface ResultsTableViewProps {
  job: ProcessingJob;
  profile: ExtractionProfile;
  onInspectDocument: (doc: PDFDocumentRecord) => void;
  onToggleReviewed: (docId: string) => void;
  onUpdateFieldValue: (docId: string, fieldId: string, newValue: string) => void;
  onOpenExport: () => void;
}

type FilterCategory = 'all' | 'review' | 'conflicts' | 'missing' | 'invalid' | 'reviewed';

export const ResultsTableView: React.FC<ResultsTableViewProps> = ({
  job,
  profile,
  onInspectDocument,
  onToggleReviewed,
  onUpdateFieldValue,
  onOpenExport,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<FilterCategory>('all');
  const [sortField, setSortField] = useState<string>('filename');
  const [sortAsc, setSortAsc] = useState<boolean>(true);

  // Inline quick-editing state: { docId, fieldId }
  const [editingCell, setEditingCell] = useState<{ docId: string; fieldId: string } | null>(null);
  const [inlineValue, setInlineValue] = useState<string>('');

  // Calculate high-level summary metrics across the documents
  const summaryMetrics = useMemo(() => {
    let totalDocs = job.documents.length;
    let completed = 0;
    let errors = 0;
    let queued = 0;
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
      completed++;
      if (!doc.isReviewed) reviewRequired++;
      if (doc.extractionMethodUsed === 'OCR_EXTRACTED') ocrUsed++;
      if (doc.extractionMethodUsed === 'AI_EXTRACTED') aiUsed++;

      for (const field of profile.fields) {
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
      reviewRequired,
      conflicts,
      missingFields,
      invalidFields,
      ocrUsed,
      aiUsed,
    };
  }, [job.documents, profile.fields]);

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
      // Queued / in-flight docs only belong in the "All" view; they have no
      // results yet, so exclude them from every quality-based filter tab.
      if (
        activeFilter !== 'all' &&
        (doc.processingStatus === 'pending' ||
          doc.processingStatus === 'processing')
      ) {
        return false;
      }
      if (activeFilter === 'review') {
        const hasFieldNeedingReview = Object.values(doc.diagnostics).some(
          (d) => d.reviewRequired || d.isConflict || d.status === 'INVALID'
        );
        return !doc.isReviewed || hasFieldNeedingReview;
      }
      if (activeFilter === 'conflicts') {
        return Object.values(doc.diagnostics).some((d) => d.isConflict);
      }
      if (activeFilter === 'missing') {
        return Object.values(doc.diagnostics).some(
          (d) => d.status === 'NOT_FOUND' && profile.fields.find((f) => f.id === d.fieldId)?.required
        );
      }
      if (activeFilter === 'invalid') {
        return Object.values(doc.diagnostics).some((d) => d.status === 'INVALID');
      }
      if (activeFilter === 'reviewed') {
        return doc.isReviewed;
      }

      return true;
    });
  }, [job.documents, searchQuery, activeFilter, profile.fields]);

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
      } else {
        valA = a.finalValues[sortField] || '';
        valB = b.finalValues[sortField] || '';
      }

      const cmp = valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' });
      return sortAsc ? cmp : -cmp;
    });
  }, [filteredDocuments, sortField, sortAsc]);

  const handleSort = (fieldId: string) => {
    if (sortField === fieldId) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(fieldId);
      setSortAsc(true);
    }
  };

  const startInlineEdit = (docId: string, fieldId: string, currentValue: string) => {
    setEditingCell({ docId, fieldId });
    setInlineValue(currentValue);
  };

  const commitInlineEdit = () => {
    if (editingCell) {
      onUpdateFieldValue(editingCell.docId, editingCell.fieldId, inlineValue);
      setEditingCell(null);
    }
  };

  const handleBatchMarkReviewed = () => {
    for (const doc of filteredDocuments) {
      if (!doc.isReviewed) {
        onToggleReviewed(doc.id);
      }
    }
  };

  return (
    <div className="space-y-6">

      {/* 1. Processing Summary KPI Strip */}
      <div className="bg-white rounded-xl border border-neutral-200 p-5 shadow-xs">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-neutral-100">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-neutral-900">
                Extraction &amp; Reconciliation Results
              </h2>
              <span className="text-xs font-mono text-neutral-500">
                Batch: {job.zipFilename}
              </span>
            </div>
            <p className="text-xs text-neutral-500 mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>
                Profile:{' '}
                <span className="font-medium text-neutral-800">{profile.name}</span>
              </span>
              <span>
                · {summaryMetrics.completed} of{' '}
                {job.totalDiscovered || job.documents.length} processed
              </span>
              {job.status === 'running' && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                  <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-emerald-300 border-t-emerald-700 animate-spin" />
                  Live — {summaryMetrics.queued} still queued
                </span>
              )}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleBatchMarkReviewed}
              className="px-3 py-1.5 text-xs font-medium text-neutral-700 bg-neutral-100 hover:bg-neutral-200 rounded-md transition-colors flex items-center gap-1.5"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Mark Filtered as Reviewed</span>
            </button>
            <button
              onClick={onOpenExport}
              className="px-3.5 py-1.5 text-xs font-medium text-white bg-neutral-900 hover:bg-neutral-800 rounded-md transition-colors flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export CSV</span>
            </button>
          </div>
        </div>

        {/* Metric Badges Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-9 gap-3 pt-4">
          <div className="p-2.5 rounded-lg bg-neutral-50 border border-neutral-200/70">
            <span className="text-[11px] font-medium text-neutral-500 block">Total Documents</span>
            <span className="text-lg font-bold text-neutral-900 font-mono tabular-nums">
              {summaryMetrics.totalDocs}
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-emerald-50/60 border border-emerald-200/60">
            <span className="text-[11px] font-medium text-emerald-800 block">Processed Clean</span>
            <span className="text-lg font-bold text-emerald-900 font-mono tabular-nums">
              {summaryMetrics.completed}
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-neutral-50 border border-neutral-200/70">
            <span className="text-[11px] font-medium text-neutral-500 block">Queued</span>
            <span className="text-lg font-bold text-neutral-600 font-mono tabular-nums">
              {summaryMetrics.queued}
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-amber-50/60 border border-amber-200/60">
            <span className="text-[11px] font-medium text-amber-800 block">Conflicts Flagged</span>
            <span className="text-lg font-bold text-amber-900 font-mono tabular-nums">
              {summaryMetrics.conflicts}
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-rose-50/60 border border-rose-200/60">
            <span className="text-[11px] font-medium text-rose-800 block">Missing Fields</span>
            <span className="text-lg font-bold text-rose-900 font-mono tabular-nums">
              {summaryMetrics.missingFields}
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-purple-50/60 border border-purple-200/60">
            <span className="text-[11px] font-medium text-purple-800 block">OCR Fallbacks</span>
            <span className="text-lg font-bold text-purple-900 font-mono tabular-nums">
              {summaryMetrics.ocrUsed}
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-sky-50/60 border border-sky-200/60">
            <span className="text-[11px] font-medium text-sky-800 block">AI-assisted</span>
            <span className="text-lg font-bold text-sky-900 font-mono tabular-nums">
              {summaryMetrics.aiUsed}
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-neutral-50 border border-neutral-200/70">
            <span className="text-[11px] font-medium text-neutral-500 block">Needs Review</span>
            <span className="text-lg font-bold text-neutral-900 font-mono tabular-nums">
              {summaryMetrics.reviewRequired}
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-blue-50/60 border border-blue-200/60">
            <span className="text-[11px] font-medium text-blue-800 block">Reviewed</span>
            <span className="text-lg font-bold text-blue-900 font-mono tabular-nums">
              {job.documents.filter((d) => d.isReviewed).length}
            </span>
          </div>
        </div>
      </div>

      {/* 2. Controls & Filter Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        {/* Category Tabs */}
        <div className="flex items-center gap-1 p-1 bg-neutral-100 rounded-lg overflow-x-auto text-xs font-medium">
          <button
            onClick={() => setActiveFilter('all')}
            className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${activeFilter === 'all'
              ? 'bg-white text-neutral-900 shadow-xs font-semibold'
              : 'text-neutral-600 hover:text-neutral-900'
              }`}
          >
            All Documents ({job.documents.length})
          </button>
          <button
            onClick={() => setActiveFilter('review')}
            className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${activeFilter === 'review'
              ? 'bg-white text-neutral-900 shadow-xs font-semibold'
              : 'text-neutral-600 hover:text-neutral-900'
              }`}
          >
            Requires Review ({summaryMetrics.reviewRequired})
          </button>
          <button
            onClick={() => setActiveFilter('conflicts')}
            className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${activeFilter === 'conflicts'
              ? 'bg-white text-neutral-900 shadow-xs font-semibold'
              : 'text-neutral-600 hover:text-neutral-900'
              }`}
          >
            Conflicts ({summaryMetrics.conflicts})
          </button>
          <button
            onClick={() => setActiveFilter('missing')}
            className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${activeFilter === 'missing'
              ? 'bg-white text-neutral-900 shadow-xs font-semibold'
              : 'text-neutral-600 hover:text-neutral-900'
              }`}
          >
            Missing Required ({summaryMetrics.missingFields})
          </button>
          <button
            onClick={() => setActiveFilter('reviewed')}
            className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${activeFilter === 'reviewed'
              ? 'bg-white text-neutral-900 shadow-xs font-semibold'
              : 'text-neutral-600 hover:text-neutral-900'
              }`}
          >
            Reviewed ({job.documents.filter((d) => d.isReviewed).length})
          </button>
        </div>

        {/* Search input */}
        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-neutral-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search filenames or values..."
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-white border border-neutral-300 rounded-md focus:outline-hidden focus:ring-2 focus:ring-neutral-900"
          />
        </div>
      </div>

      {/* 3. High-Density Spreadsheet Data Grid */}
      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-neutral-50/80 border-b border-neutral-200 text-neutral-600 font-semibold select-none">
                <th className="py-2.5 px-3 w-10 text-center">Status</th>
                <th
                  onClick={() => handleSort('filename')}
                  className="py-2.5 px-3 cursor-pointer hover:text-neutral-900 whitespace-nowrap"
                >
                  <div className="flex items-center gap-1.5">
                    <span>Document / Filename</span>
                    <ArrowUpDown className="w-3 h-3 text-neutral-400" />
                  </div>
                </th>
                <th
                  onClick={() => handleSort('path')}
                  className="py-2.5 px-3 cursor-pointer hover:text-neutral-900 whitespace-nowrap"
                >
                  <div className="flex items-center gap-1.5">
                    <span>Path</span>
                    <ArrowUpDown className="w-3 h-3 text-neutral-400" />
                  </div>
                </th>

                {/* Profile Field Columns */}
                {profile.fields.map((field) => (
                  <th
                    key={field.id}
                    onClick={() => handleSort(field.id)}
                    className="py-2.5 px-3 cursor-pointer hover:text-neutral-900 whitespace-nowrap"
                  >
                    <div className="flex items-center gap-1.5">
                      <span>{field.name}</span>
                      <ArrowUpDown className="w-3 h-3 text-neutral-400" />
                    </div>
                  </th>
                ))}

                <th className="py-2.5 px-3 text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {sortedDocuments.length === 0 ? (
                <tr>
                  <td
                    colSpan={profile.fields.length + 4}
                    className="py-12 text-center text-neutral-500 text-xs"
                  >
                    No documents found matching the active filter and search terms.
                  </td>
                </tr>
              ) : (
                sortedDocuments.map((doc) => {
                  const hasConflict = Object.values(doc.diagnostics).some((d) => d.isConflict);
                  const isPending =
                    doc.processingStatus === 'pending' ||
                    doc.processingStatus === 'processing';
                  const hasProcessingWarning = Boolean(doc.errorDetails);
                  const hasMissingRequired = Object.values(doc.diagnostics).some(
                    (d) => d.status === 'NOT_FOUND' && profile.fields.find((f) => f.id === d.fieldId)?.required
                  );
                  const isOcrOrAi =
                    doc.extractionMethodUsed === 'OCR_EXTRACTED' ||
                    doc.extractionMethodUsed === 'AI_EXTRACTED';
                  const isAi = doc.extractionMethodUsed === 'AI_EXTRACTED';

                  return (
                    <tr
                      key={doc.id}
                      className={`transition-colors group ${isPending ? 'opacity-60' : 'hover:bg-neutral-50/70'}`}
                    >
                      {/* Status Icon */}
                      <td className="py-2.5 px-3 text-center">
                        {isPending ? (
                          <span
                            title={
                              doc.processingStatus === 'processing'
                                ? 'Processing...'
                                : 'Queued for processing'
                            }
                            className="inline-flex items-center justify-center"
                          >
                            <span
                              className={`inline-block w-3.5 h-3.5 rounded-full border-2 ${doc.processingStatus === 'processing'
                                ? 'border-neutral-300 border-t-neutral-700 animate-spin'
                                : 'border-neutral-200'
                                }`}
                            />
                          </span>
                        ) : hasProcessingWarning ? (
                          <span
                            title={`Processing warning: ${doc.errorDetails}`}
                            className="inline-flex items-center justify-center"
                          >
                            <AlertTriangle className="w-4 h-4 text-amber-600 inline" />
                          </span>
                        ) : doc.isReviewed ? (
                          <span title="Reviewed and Verified" className="inline-flex items-center justify-center">
                            <CheckCircle2 className="w-4 h-4 text-emerald-600 inline" />
                          </span>
                        ) : hasConflict ? (
                          <span title="Conflict detected between Filename and PDF" className="inline-flex items-center justify-center">
                            <AlertTriangle className="w-4 h-4 text-amber-500 inline" />
                          </span>
                        ) : hasMissingRequired ? (
                          <span title="Missing required fields" className="inline-flex items-center justify-center">
                            <AlertCircle className="w-4 h-4 text-rose-500 inline" />
                          </span>
                        ) : isOcrOrAi ? (
                          <span
                            title={
                              isAi
                                ? 'Local AI-assisted extraction; verify values'
                                : 'Extracted via OCR Fallback'
                            }
                            className="inline-flex items-center justify-center"
                          >
                            <Sparkles
                              className={`w-4 h-4 ${isAi ? 'text-sky-700' : 'text-purple-600'
                                } inline`}
                            />
                          </span>
                        ) : (
                          <span title="Ready for review" className="inline-flex items-center justify-center">
                            <Check className="w-3.5 h-3.5 text-neutral-400 inline" />
                          </span>
                        )}
                      </td>

                      {/* Filename */}
                      <td className="py-2.5 px-3 font-medium text-neutral-900 whitespace-nowrap max-w-xs truncate">
                        <button
                          onClick={() => onInspectDocument(doc)}
                          className="hover:underline text-left"
                          title="Click to inspect PDF"
                        >
                          {doc.filename}
                        </button>
                      </td>

                      {/* Path */}
                      <td className="py-2.5 px-3 text-neutral-500 font-mono text-[11px] whitespace-nowrap max-w-[140px] truncate" title={doc.relativePath}>
                        {doc.relativePath}
                      </td>

                      {/* Field Value Cells with Status Tinting & Inline Edit */}
                      {profile.fields.map((field) => {
                        const diag = doc.diagnostics[field.id];
                        const val = doc.finalValues[field.id] || diag?.finalValue || '';
                        const isConflictCell = diag?.isConflict;
                        const isMissingCell = diag?.status === 'NOT_FOUND';
                        const isInvalidCell = diag?.status === 'INVALID';
                        const isFilenameOnlyCell = diag?.status === 'FILENAME_ONLY';
                        const isCorrected = diag?.isManuallyCorrected;
                        const isOcrCell = diag?.source === 'ocr';
                        const isAiCell = diag?.source === 'ai';
                        const isFormCell = diag?.source === 'form_field';

                        const isCurrentlyEditing =
                          editingCell?.docId === doc.id && editingCell?.fieldId === field.id;

                        if (isCurrentlyEditing) {
                          return (
                            <td key={field.id} className="py-1 px-2 whitespace-nowrap">
                              <input
                                autoFocus
                                type="text"
                                value={inlineValue}
                                onChange={(e) => setInlineValue(e.target.value)}
                                onBlur={commitInlineEdit}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') commitInlineEdit();
                                  if (e.key === 'Escape') setEditingCell(null);
                                }}
                                className="px-2 py-1 text-xs border border-neutral-900 rounded bg-white font-mono w-full min-w-[120px]"
                              />
                            </td>
                          );
                        }

                        if (isPending) {
                          return (
                            <td key={field.id} className="py-2.5 px-3 whitespace-nowrap">
                              <span className="text-[11px] italic text-neutral-400">
                                {doc.processingStatus === 'processing'
                                  ? 'Processing…'
                                  : 'Queued'}
                              </span>
                            </td>
                          );
                        }

                        return (
                          <td
                            key={field.id}
                            onDoubleClick={() => startInlineEdit(doc.id, field.id, val)}
                            className="py-2.5 px-3 whitespace-nowrap"
                          >
                            <div className="flex items-center gap-1.5">
                              {val ? (
                                <span
                                  className={`font-mono text-xs ${isConflictCell
                                    ? 'text-amber-800 font-semibold bg-amber-50 px-1.5 py-0.5 rounded'
                                    : isInvalidCell
                                      ? 'text-rose-800 font-semibold bg-rose-50 px-1.5 py-0.5 rounded'
                                      : isCorrected
                                        ? 'text-blue-800 font-medium'
                                        : 'text-neutral-800'
                                    }`}
                                  title={diag?.explanation || val}
                                >
                                  {val}
                                </span>
                              ) : (
                                <span
                                  className={`text-[11px] italic ${field.required ? 'text-rose-500 font-medium' : 'text-neutral-400'
                                    }`}
                                >
                                  {field.required ? 'Missing' : '—'}
                                </span>
                              )}

                              {isConflictCell && (
                                <span
                                  className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"
                                  title="Conflict between sources"
                                />
                              )}
                              {isFormCell && (
                                <span
                                  className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0"
                                  title="Filled form-field (AcroForm) value"
                                />
                              )}
                              {isFilenameOnlyCell && (
                                <span
                                  className="w-1.5 h-1.5 rounded-full border border-amber-500 bg-amber-200 shrink-0"
                                  title="Filename-only match; no document-side value existed to cross-check it"
                                />
                              )}
                              {isOcrCell && (
                                <span
                                  className="w-1.5 h-1.5 rounded-full bg-purple-500 shrink-0"
                                  title="OCR extracted"
                                />
                              )}
                              {isAiCell && (
                                <span
                                  className="w-1.5 h-1.5 rounded-full bg-sky-600 shrink-0"
                                  title="Local AI extracted; verify this value"
                                />
                              )}
                              {isCorrected && (
                                <span
                                  className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0"
                                  title="Manually edited"
                                />
                              )}
                            </div>
                          </td>
                        );
                      })}

                      {/* Row Action Buttons */}
                      <td className="py-2.5 px-3 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => onInspectDocument(doc)}
                            className="p-1 text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 rounded transition-colors"
                            title="Inspect PDF and Diagnostics"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => onToggleReviewed(doc.id)}
                            className={`p-1 rounded transition-colors ${doc.isReviewed
                              ? 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100'
                              : 'text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100'
                              }`}
                            title={doc.isReviewed ? 'Mark Unreviewed' : 'Mark Reviewed'}
                          >
                            <Check className="w-3.5 h-3.5" />
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

        {/* Table Footer info */}
        <div className="px-4 py-3 bg-neutral-50/60 border-t border-neutral-200 flex items-center justify-between text-xs text-neutral-500 font-mono">
          <span>
            Showing {sortedDocuments.length} of {job.documents.length} documents
          </span>
          <span className="hidden sm:inline">
            Double-click any cell to quickly edit value inline
          </span>
        </div>
      </div>
    </div>
  );
};
