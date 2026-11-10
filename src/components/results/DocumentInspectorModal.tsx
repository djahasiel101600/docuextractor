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
} from 'lucide-react';
import { PDFDocumentRecord, ExtractionProfile, FieldDefinition } from '../../types/extraction';
import { renderPdfPageToCanvas } from '../../services/pdfService';

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

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const activeField: FieldDefinition | undefined = profile.fields.find((f) => f.id === activeFieldId);
  const activeDiagnostic = doc.diagnostics[activeFieldId];
  const currentValue = doc.finalValues[activeFieldId] || activeDiagnostic?.finalValue || '';

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

    renderPdfPageToCanvas(pdfBuffer, currentPage, canvasRef.current, zoomScale, currentValue, {
      filename: doc.filename,
      finalValues: doc.finalValues,
      rawText: doc.rawExtractedPdfText,
    })
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
  }, [pdfBuffer, currentPage, zoomScale, viewMode, currentValue, doc.filename, doc.finalValues, doc.rawExtractedPdfText]);

  const handleSaveCorrection = () => {
    onUpdateFieldValue(doc.id, activeFieldId, editingValue);
    setIsEditing(false);
  };

  const handleQuickAccept = (val: string) => {
    onUpdateFieldValue(doc.id, activeFieldId, val);
    setEditingValue(val);
    setIsEditing(false);
  };

  const totalPages = doc.pageCount || 1;

  return (
    <div className="fixed inset-0 z-50 bg-neutral-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl border border-neutral-200 w-full max-w-7xl h-[92vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-98 duration-150">

        {/* Modal Top Bar */}
        <div className="flex items-center justify-between px-6 py-3.5 border-b border-neutral-200 bg-neutral-50/70 shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-1.5 rounded-md bg-white border border-neutral-200 text-neutral-700">
              <FileText className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-neutral-900 truncate max-w-lg">
                  {doc.filename}
                </h3>
                {doc.isReviewed ? (
                  <span className="text-xs font-medium text-emerald-700 flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Reviewed
                  </span>
                ) : (
                  <span className="text-xs font-medium text-amber-700 flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" /> Pending Verification
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-xs text-neutral-500 font-mono">
                  {doc.relativePath} · {Math.round(doc.fileSizeBytes / 1024)} KB · {doc.pageCount} page(s) · Method: {doc.extractionMethodUsed}
                </p>
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-neutral-200 bg-white text-[10px] font-semibold text-neutral-700"
                  title={doc.assignmentRule || doc.assignmentReason || 'Extraction Profile used for this document'}
                >
                  <LayoutTemplate className="w-3 h-3" />
                  {doc.profileName ||
                    (doc.profileId ? profile.name : 'No profile assigned')}
                </span>
                <span
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${ASSIGNMENT_BADGE_STYLES[doc.assignmentStatus]}`}
                  title={doc.assignmentReason || undefined}
                >
                  {doc.assignmentStatus === 'excluded' && <Ban className="w-3 h-3" />}
                  {ASSIGNMENT_BADGE_LABEL[doc.assignmentStatus]}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => onToggleReviewed(doc.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 ${doc.isReviewed
                ? 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
                : 'bg-emerald-600 text-white hover:bg-emerald-700'
                }`}
            >
              <Check className="w-3.5 h-3.5" />
              <span>{doc.isReviewed ? 'Mark as Unreviewed' : 'Mark as Reviewed'}</span>
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-neutral-500 hover:text-neutral-900 hover:bg-neutral-200 rounded-md transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Modal Body: Two Column Split (Left: PDF Viewer, Right: Field Diagnostics & Trace) */}
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden min-h-0">

          {/* Left Column: Interactive PDF Preview */}
          <div className="flex-1 flex flex-col bg-neutral-100 border-r border-neutral-200 overflow-hidden">
            {/* PDF Toolbar */}
            <div className="flex items-center justify-between px-4 py-2 bg-white border-b border-neutral-200 text-xs text-neutral-600 shrink-0 gap-3">
              <div className="flex items-center gap-1.5 p-0.5 bg-neutral-100 rounded-md">
                <button
                  type="button"
                  onClick={() => setViewMode('canvas')}
                  className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors flex items-center gap-1.5 ${viewMode === 'canvas'
                    ? 'bg-white text-neutral-900 shadow-xs font-semibold'
                    : 'text-neutral-600 hover:text-neutral-900'
                    }`}
                  title="PDF Canvas rendering with active field highlighting"
                >
                  <Eye className="w-3.5 h-3.5" />
                  <span>Canvas Preview</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('form')}
                  className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors flex items-center gap-1.5 ${viewMode === 'form'
                    ? 'bg-white text-neutral-900 shadow-xs font-semibold'
                    : 'text-neutral-600 hover:text-neutral-900'
                    }`}
                  title="Structured Form layout with extracted fields"
                >
                  <LayoutTemplate className="w-3.5 h-3.5" />
                  <span>Form Document View</span>
                </button>
                {blobUrl && (
                  <a
                    href={blobUrl}
                    download={doc.filename}
                    className="px-2.5 py-1 text-[11px] font-medium rounded transition-colors flex items-center gap-1.5 text-neutral-600 hover:text-neutral-900 hover:bg-white"
                    title="Download original PDF file"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download PDF</span>
                  </a>
                )}
              </div>

              {viewMode === 'canvas' && (
                <div className="flex items-center gap-1">
                  <button
                    disabled={currentPage <= 1}
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    className="p-1 rounded hover:bg-neutral-100 disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Previous Page"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="font-mono tabular-nums px-2">
                    Page {currentPage} of {totalPages}
                  </span>
                  <button
                    disabled={currentPage >= totalPages}
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    className="p-1 rounded hover:bg-neutral-100 disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Next Page"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              )}

              {viewMode === 'canvas' && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setZoomScale((z) => Math.max(0.6, z - 0.2))}
                    className="p-1 rounded hover:bg-neutral-100"
                    title="Zoom Out"
                  >
                    <ZoomOut className="w-4 h-4" />
                  </button>
                  <span className="font-mono tabular-nums px-1 text-neutral-500">
                    {Math.round(zoomScale * 100)}%
                  </span>
                  <button
                    onClick={() => setZoomScale((z) => Math.min(2.5, z + 0.2))}
                    className="p-1 rounded hover:bg-neutral-100"
                    title="Zoom In"
                  >
                    <ZoomIn className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setZoomScale(1.2)}
                    className="p-1 rounded hover:bg-neutral-100 text-neutral-500 ml-1"
                    title="Reset Zoom"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            {/* Viewport Container */}
            <div className="flex-1 overflow-auto p-4 flex items-center justify-center relative bg-neutral-200/50">
              {viewMode === 'canvas' ? (
                <>
                  {isRendering && (
                    <div className="absolute inset-0 bg-white/70 backdrop-blur-xs flex flex-col items-center justify-center z-10 gap-2">
                      <div className="w-6 h-6 border-2 border-neutral-900 border-t-transparent rounded-full animate-spin" />
                      <span className="text-xs font-medium text-neutral-700">
                        Rendering PDF page from digital stream...
                      </span>
                    </div>
                  )}

                  {renderError ? (
                    <div className="p-8 text-center max-w-md bg-white rounded-xl shadow-md border border-neutral-200 space-y-4">
                      <AlertCircle className="w-8 h-8 text-rose-500 mx-auto" />
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-neutral-900">
                          Canvas Rendering Notice
                        </p>
                        <p className="text-xs text-neutral-600 leading-relaxed">
                          {renderError}
                        </p>
                      </div>
                      <div className="flex items-center justify-center gap-2 pt-2">
                        <button
                          type="button"
                          onClick={() => setViewMode('form')}
                          className="px-3.5 py-1.5 text-xs font-semibold text-white bg-neutral-900 hover:bg-neutral-800 rounded-md transition-colors"
                        >
                          Switch to Form Document View
                        </button>
                        {blobUrl && (
                          <a
                            href={blobUrl}
                            download={doc.filename}
                            className="px-3.5 py-1.5 text-xs font-semibold text-neutral-800 bg-neutral-100 hover:bg-neutral-200 rounded-md transition-colors border border-neutral-200 flex items-center gap-1.5"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>Download PDF</span>
                          </a>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="shadow-lg border border-neutral-300 bg-white transition-transform rounded-xs overflow-hidden my-auto">
                      <canvas ref={canvasRef} className="block" />
                    </div>
                  )}
                </>
              ) : (
                /* Form Document View: Authentic digital form rendering */
                <div className="w-full max-w-2xl bg-white rounded-lg shadow-lg border border-neutral-300 p-8 space-y-6 my-auto text-neutral-900 font-sans">
                  {/* Official Header */}
                  <div className="border-b-2 border-neutral-900 pb-4 text-center space-y-1">
                    <span className="text-[10px] uppercase font-bold tracking-widest text-neutral-500 block">
                      OFFICIAL CIVIL REGISTRY &amp; PUBLIC APPLICATION RECORD
                    </span>
                    <h2 className="text-lg font-black tracking-tight text-neutral-900">
                      {doc.filename.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ')}
                    </h2>
                    <p className="text-[11px] text-neutral-500 font-mono">
                      Relative Archive Path: {doc.relativePath} · {Math.round(doc.fileSizeBytes / 1024)} KB
                    </p>
                  </div>

                  {/* Structured Form Fields */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                    {profile.fields.map((field) => {
                      const diag = doc.diagnostics[field.id];
                      const val = doc.finalValues[field.id] || diag?.finalValue || '';
                      const isSelected = activeFieldId === field.id;
                      const isConflict = diag?.isConflict;

                      return (
                        <div
                          key={field.id}
                          onClick={() => setActiveFieldId(field.id)}
                          className={`p-3 rounded-lg border transition-all cursor-pointer ${isSelected
                            ? 'border-neutral-900 bg-neutral-50 ring-2 ring-neutral-900'
                            : isConflict
                              ? 'border-amber-300 bg-amber-50/50 hover:bg-amber-50'
                              : 'border-neutral-200 hover:bg-neutral-50/60'
                            }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">
                              {field.label || field.name}
                            </span>
                            {isSelected && (
                              <span className="text-[10px] font-bold text-neutral-900 uppercase">
                                Selected
                              </span>
                            )}
                          </div>
                          <div className="text-sm font-bold font-mono text-neutral-900 mt-1">
                            {val || <span className="text-neutral-400 font-normal italic">Not Specified</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Supporting Extracted Text Stream */}
                  {doc.rawExtractedPdfText && (
                    <div className="space-y-1.5 pt-4 border-t border-neutral-200">
                      <span className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider block">
                        Raw PDF Digital Content Stream ({doc.pdfTextLength} characters)
                      </span>
                      <pre className="p-3 bg-neutral-900 text-neutral-200 rounded-md text-[11px] font-mono leading-relaxed max-h-36 overflow-y-auto whitespace-pre-wrap">
                        {doc.rawExtractedPdfText}
                      </pre>
                    </div>
                  )}

                  {/* Official Footer & Verification Stamp */}
                  <div className="pt-4 border-t border-neutral-200 flex items-center justify-between text-[10px] text-neutral-400 font-mono">
                    <span>Extraction Method: {doc.extractionMethodUsed}</span>
                    <span>System Generated Form · Verification Code: 2026-REG-AUTO</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Field Diagnostics, Reconciliation & Audit Trace */}
          <div className="w-full md:w-[480px] lg:w-[520px] flex flex-col bg-white overflow-hidden shrink-0">

            {/* Field Tabs Selector */}
            <div className="p-3 border-b border-neutral-200 bg-neutral-50/50 shrink-0">
              <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider block mb-2">
                Select Field to Inspect
              </label>
              <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-thin">
                {profile.fields.map((field) => {
                  const diag = doc.diagnostics[field.id];
                  const hasConflict = diag?.isConflict;
                  const isMissing = diag?.status === 'NOT_FOUND';
                  const isInvalid = diag?.status === 'INVALID';
                  const isCorrected = diag?.isManuallyCorrected;

                  return (
                    <button
                      key={field.id}
                      onClick={() => setActiveFieldId(field.id)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors flex items-center gap-1.5 ${activeFieldId === field.id
                        ? 'bg-neutral-900 text-white shadow-xs'
                        : 'bg-white border border-neutral-200 text-neutral-700 hover:bg-neutral-100'
                        }`}
                    >
                      <span>{field.name}</span>
                      {hasConflict && (
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" title="Conflict" />
                      )}
                      {isInvalid && (
                        <span className="w-1.5 h-1.5 rounded-full bg-rose-500" title="Invalid format" />
                      )}
                      {isMissing && field.required && (
                        <span className="w-1.5 h-1.5 rounded-full bg-neutral-400" title="Missing required" />
                      )}
                      {isCorrected && (
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-500" title="Manually edited" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Diagnostic Details Scrollable Panel */}
            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {doc.processingStatus === 'excluded' && (
                <div
                  role="status"
                  className="rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-3 text-xs text-neutral-700"
                >
                  <span className="font-semibold">Excluded from processing: </span>
                  This document was intentionally skipped, so no fields were extracted for{' '}
                  {profile.name}. {doc.assignmentReason}
                </div>
              )}
              {doc.errorDetails && (
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
                  {/* Current Reconciled Value Card */}
                  <div className="p-4 rounded-lg border border-neutral-200 bg-neutral-50/40 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                        Reconciled Final Value
                      </span>
                      {activeDiagnostic.isManuallyCorrected && (
                        <span className="text-xs text-blue-700 font-medium">
                          Manually Corrected
                        </span>
                      )}
                    </div>

                    {isEditing ? (
                      <div className="space-y-2">
                        <input
                          type="text"
                          value={editingValue}
                          onChange={(e) => setEditingValue(e.target.value)}
                          className="w-full px-3 py-2 text-sm bg-white border border-neutral-300 rounded-md focus:outline-hidden focus:ring-2 focus:ring-neutral-900"
                          placeholder="Enter corrected value..."
                        />
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => {
                              setIsEditing(false);
                              setEditingValue(currentValue);
                            }}
                            className="px-2.5 py-1 text-xs text-neutral-600 hover:text-neutral-900"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleSaveCorrection}
                            className="px-3 py-1 text-xs font-medium text-white bg-neutral-900 hover:bg-neutral-800 rounded-md flex items-center gap-1"
                          >
                            <Save className="w-3 h-3" />
                            <span>Save Value</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-base font-semibold text-neutral-900 font-mono">
                          {currentValue || <span className="text-neutral-400 italic">No value</span>}
                        </span>
                        <button
                          onClick={() => setIsEditing(true)}
                          className="p-1.5 text-neutral-500 hover:text-neutral-900 hover:bg-neutral-200/60 rounded-md transition-colors"
                          title="Edit value"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}

                    {/* Diagnostic Status Badge & Explanation */}
                    <div className="pt-2 border-t border-neutral-200/80 space-y-1">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-semibold text-neutral-700">Diagnostic Status:</span>
                        <span className={`font-mono px-1.5 py-0.5 rounded text-[11px] font-semibold ${activeDiagnostic.status === 'MATCHED'
                          ? 'bg-emerald-100 text-emerald-800'
                          : activeDiagnostic.status === 'MISMATCH'
                            ? 'bg-amber-100 text-amber-900'
                            : activeDiagnostic.status === 'INVALID'
                              ? 'bg-rose-100 text-rose-900'
                              : activeDiagnostic.status === 'OCR_EXTRACTED'
                                ? 'bg-purple-100 text-purple-900'
                                : activeDiagnostic.status === 'AI_EXTRACTED'
                                  ? 'bg-sky-100 text-sky-900'
                                  : activeDiagnostic.status === 'FILENAME_ONLY'
                                    ? 'bg-amber-50 text-amber-800 border border-amber-200'
                                    : 'bg-neutral-200 text-neutral-800'
                          }`}>
                          {activeDiagnostic.status}
                        </span>
                        {activeDiagnostic.confidenceScore !== undefined && (
                          <span className="text-neutral-500 font-mono text-[11px]">
                            {Math.round(activeDiagnostic.confidenceScore * 100)}% evidence score
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-neutral-600 leading-relaxed">
                        {activeDiagnostic.explanation}
                      </p>
                      {activeDiagnostic.selectionReason && (
                        <p className="text-[11px] text-neutral-500 leading-relaxed">
                          Selection: {activeDiagnostic.selectionReason}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Multi-Source Comparison Table */}
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold text-neutral-700 uppercase tracking-wider">
                      Extraction Sources Comparison
                    </h4>

                    <div className="border border-neutral-200 rounded-lg overflow-hidden text-xs">
                      {/* Filename Extraction Row */}
                      <div className="p-3 bg-white border-b border-neutral-200 flex items-start justify-between gap-4">
                        <div className="space-y-1 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-neutral-800">Filename Regex Extraction</span>
                            {activeDiagnostic.source === 'filename' && (
                              <span className="text-[10px] text-emerald-700 font-medium">Selected Source</span>
                            )}
                          </div>
                          <div className="text-xs font-mono text-neutral-700">
                            {activeDiagnostic.filenameValue || <span className="text-neutral-400 italic">No match</span>}
                          </div>
                          {activeField.filenameRules.patterns[0] && (
                            <p className="text-[11px] text-neutral-500 font-mono truncate">
                              Rule: {activeField.filenameRules.patterns[0]}
                            </p>
                          )}
                        </div>
                        {activeDiagnostic.filenameValue && activeDiagnostic.filenameValue !== currentValue && (
                          <button
                            onClick={() => handleQuickAccept(activeDiagnostic.filenameValue!)}
                            className="text-[11px] text-neutral-700 hover:text-neutral-900 border border-neutral-200 px-2 py-1 rounded bg-neutral-50 hover:bg-neutral-100 whitespace-nowrap"
                          >
                            Use This Value
                          </button>
                        )}
                      </div>

                      {/* AcroForm Filled Field Value Row (authoritative) */}
                      {activeDiagnostic.formValue && (
                        <div className="p-3 bg-emerald-50/60 border-b border-neutral-200 flex items-start justify-between gap-4">
                          <div className="space-y-1 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-emerald-900 flex items-center gap-1">
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> Form Field Value
                              </span>
                              {activeDiagnostic.source === 'form_field' && (
                                <span className="text-[10px] text-emerald-700 font-medium">Selected Source</span>
                              )}
                            </div>
                            <div className="text-xs font-mono text-emerald-950">
                              {activeDiagnostic.formValue}
                            </div>
                            {activeDiagnostic.formConfidenceScore !== undefined && (
                              <p className="text-[11px] text-emerald-800">
                                Evidence score: {Math.round((activeDiagnostic.formConfidenceScore ?? 0) * 100)}%
                                {activeDiagnostic.formMethod ? ` · ${activeDiagnostic.formMethod.replace('acroform_', 'AcroForm ')}` : ''}
                                {activeDiagnostic.formPageNumber ? ` · Page ${activeDiagnostic.formPageNumber}` : ''}
                              </p>
                            )}
                            {activeDiagnostic.formEvidence && (
                              <p className="text-[11px] text-emerald-800 whitespace-pre-wrap">
                                Evidence: {activeDiagnostic.formEvidence}
                              </p>
                            )}
                          </div>
                          {activeDiagnostic.formValue !== currentValue && (
                            <button
                              onClick={() => handleQuickAccept(activeDiagnostic.formValue!)}
                              className="text-[11px] text-neutral-700 hover:text-neutral-900 border border-neutral-200 px-2 py-1 rounded bg-white hover:bg-neutral-100 whitespace-nowrap"
                            >
                              Use This Value
                            </button>
                          )}
                        </div>
                      )}

                      {/* PDF Content Extraction Row */}
                      <div className="p-3 bg-white border-b border-neutral-200 flex items-start justify-between gap-4">
                        <div className="space-y-1 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-neutral-800">PDF Content Extraction</span>
                            {activeDiagnostic.source === 'pdf_text' && (
                              <span className="text-[10px] text-emerald-700 font-medium">Selected Source</span>
                            )}
                          </div>
                          <div className="text-xs font-mono text-neutral-700">
                            {activeDiagnostic.pdfValue || <span className="text-neutral-400 italic">No match</span>}
                          </div>
                          {activeDiagnostic.candidateScores?.pdf_text !== undefined && (
                            <p className="text-[11px] text-neutral-500">
                              Evidence score: {Math.round(activeDiagnostic.candidateScores.pdf_text * 100)}%
                              {activeDiagnostic.pdfPageNumber ? ` · Page ${activeDiagnostic.pdfPageNumber}` : ''}
                            </p>
                          )}
                          {activeDiagnostic.pdfEvidence && (
                            <p className="text-[11px] text-neutral-500 whitespace-pre-wrap">
                              Evidence: {activeDiagnostic.pdfEvidence}
                            </p>
                          )}
                          {activeDiagnostic.matchedPatternOrLabel && (
                            <p className="text-[11px] text-neutral-500 font-mono truncate">
                              Label/Pattern: {activeDiagnostic.matchedPatternOrLabel}
                            </p>
                          )}
                        </div>
                        {activeDiagnostic.pdfValue && activeDiagnostic.pdfValue !== currentValue && (
                          <button
                            onClick={() => handleQuickAccept(activeDiagnostic.pdfValue!)}
                            className="text-[11px] text-neutral-700 hover:text-neutral-900 border border-neutral-200 px-2 py-1 rounded bg-neutral-50 hover:bg-neutral-100 whitespace-nowrap"
                          >
                            Use This Value
                          </button>
                        )}
                      </div>

                      {/* OCR Extraction Row (if available) */}
                      {activeDiagnostic.ocrValue && (
                        <div className="p-3 bg-purple-50/50 flex items-start justify-between gap-4">
                          <div className="space-y-1 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-purple-900 flex items-center gap-1">
                                <Sparkles className="w-3 h-3 text-purple-600" /> OCR Candidate
                              </span>
                            </div>
                            <div className="text-xs font-mono text-purple-950">
                              {activeDiagnostic.ocrValue}
                            </div>
                            {activeDiagnostic.candidateScores?.ocr !== undefined && (
                              <p className="text-[11px] text-purple-800">
                                Evidence score: {Math.round(activeDiagnostic.candidateScores.ocr * 100)}%
                                {activeDiagnostic.ocrPageNumber ? ` · Page ${activeDiagnostic.ocrPageNumber}` : ''}
                              </p>
                            )}
                            {activeDiagnostic.ocrEvidence && (
                              <p className="text-[11px] text-purple-800 whitespace-pre-wrap">
                                Evidence: {activeDiagnostic.ocrEvidence}
                              </p>
                            )}
                          </div>
                          {activeDiagnostic.ocrValue !== currentValue && (
                            <button
                              onClick={() => handleQuickAccept(activeDiagnostic.ocrValue!)}
                              className="text-[11px] text-neutral-700 hover:text-neutral-900 border border-neutral-200 px-2 py-1 rounded bg-white hover:bg-neutral-100 whitespace-nowrap"
                            >
                              Use This Value
                            </button>
                          )}
                        </div>
                      )}

                      {activeDiagnostic.aiValue && (
                        <div className="p-3 bg-sky-50 flex items-start justify-between gap-4">
                          <div className="space-y-1 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-sky-900 flex items-center gap-1">
                                <Sparkles className="w-3 h-3 text-sky-700" />
                                AI Candidate (Ollama)
                              </span>
                              {activeDiagnostic.source === 'ai' && (
                                <span className="text-[10px] text-sky-800 font-medium">
                                  Selected Source · Verify
                                </span>
                              )}
                            </div>
                            <div className="text-xs font-mono text-sky-950">
                              {activeDiagnostic.aiValue}
                            </div>
                            {activeDiagnostic.aiEvidence && (
                              <div className="text-[11px] text-sky-800">
                                {activeDiagnostic.aiSourceKind
                                  ? `Source: ${activeDiagnostic.aiSourceKind} · `
                                  : ''}
                                Evidence: {activeDiagnostic.aiEvidence}
                                {activeDiagnostic.source === 'ai' &&
                                  activeDiagnostic.pageNumber &&
                                  ` (page ${activeDiagnostic.pageNumber})`}
                              </div>
                            )}
                          </div>
                          {activeDiagnostic.aiValue !== currentValue && (
                            <button
                              onClick={() =>
                                handleQuickAccept(activeDiagnostic.aiValue!)
                              }
                              className="text-[11px] text-neutral-700 hover:text-neutral-900 border border-neutral-200 px-2 py-1 rounded bg-white hover:bg-neutral-100 whitespace-nowrap"
                            >
                              Use This Value
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Supporting Contextual Text Evidence */}
                  {activeDiagnostic.supportingEvidence && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-neutral-700 uppercase tracking-wider">
                          Contextual Text Evidence (Page {activeDiagnostic.pageNumber || 1})
                        </span>
                      </div>
                      <div className="p-3 bg-neutral-900 text-neutral-200 rounded-lg text-xs font-mono whitespace-pre-wrap leading-relaxed max-h-36 overflow-y-auto">
                        {activeDiagnostic.supportingEvidence}
                      </div>
                      <p className="text-[11px] text-neutral-500">
                        Extracted text surrounding the matched pattern in the original PDF content.
                      </p>
                    </div>
                  )}

                  {/* Field Configuration Rules Preview */}
                  <div className="p-3.5 rounded-lg border border-neutral-200 bg-white space-y-2 text-xs">
                    <span className="font-semibold text-neutral-700 block">
                      Active Extraction Rules for {activeField.name}
                    </span>
                    <div className="grid grid-cols-2 gap-2 text-neutral-600">
                      <div>
                        <span className="text-neutral-400 block text-[11px]">Priority:</span>
                        <span className="font-medium text-neutral-800">
                          {activeField.priority.replace('_', ' ')}
                        </span>
                      </div>
                      <div>
                        <span className="text-neutral-400 block text-[11px]">Normalization:</span>
                        <span className="font-medium text-neutral-800">
                          {activeField.normalization.caseTransform} · Trim
                        </span>
                      </div>
                      <div>
                        <span className="text-neutral-400 block text-[11px]">Validation:</span>
                        <span className="font-medium text-neutral-800">
                          {activeField.required ? 'Required' : 'Optional'}
                          {activeField.validation.allowedValues
                            ? ` · [${activeField.validation.allowedValues.join(', ')}]`
                            : ''}
                        </span>
                      </div>
                      <div>
                        <span className="text-neutral-400 block text-[11px]">Validation Result:</span>
                        <span
                          className={`font-semibold ${activeDiagnostic.validationPassed
                            ? 'text-emerald-700'
                            : 'text-rose-700'
                            }`}
                        >
                          {activeDiagnostic.validationPassed ? 'Passed' : activeDiagnostic.validationError}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Audit Trail of User Corrections */}
                  {doc.editHistory && doc.editHistory.length > 0 && (
                    <div className="space-y-1.5 pt-2">
                      <span className="text-xs font-semibold text-neutral-700 uppercase tracking-wider block">
                        Audit Trail of Modifications
                      </span>
                      <div className="space-y-1.5">
                        {doc.editHistory.map((item, idx) => (
                          <div
                            key={idx}
                            className="p-2.5 rounded bg-neutral-50 border border-neutral-200 text-xs flex items-center justify-between"
                          >
                            <div className="space-y-0.5">
                              <span className="font-medium text-neutral-800">
                                {profile.fields.find((f) => f.id === item.fieldId)?.name || item.fieldId}
                              </span>
                              <div className="flex items-center gap-1.5 font-mono text-[11px] text-neutral-600">
                                <span className="line-through text-neutral-400">{item.previousValue || '(empty)'}</span>
                                <ArrowRight className="w-3 h-3 text-neutral-400" />
                                <span className="font-semibold text-neutral-900">{item.newValue}</span>
                              </div>
                            </div>
                            <span className="text-[10px] text-neutral-400 font-mono">
                              {new Date(item.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="text-center py-12 text-neutral-400 text-xs">
                  Select a field above to inspect diagnostic details.
                </div>
              )}
            </div>

            {/* Modal Bottom Action Strip */}
            <div className="p-3.5 border-t border-neutral-200 bg-neutral-50 flex items-center justify-between text-xs shrink-0">
              <span className="text-neutral-500 font-mono">
                Field {profile.fields.findIndex((f) => f.id === activeFieldId) + 1} of {profile.fields.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  disabled={profile.fields.findIndex((f) => f.id === activeFieldId) <= 0}
                  onClick={() => {
                    const idx = profile.fields.findIndex((f) => f.id === activeFieldId);
                    if (idx > 0) setActiveFieldId(profile.fields[idx - 1].id);
                  }}
                  className="px-2.5 py-1 rounded border border-neutral-200 bg-white hover:bg-neutral-100 disabled:opacity-30"
                >
                  Previous Field
                </button>
                <button
                  disabled={profile.fields.findIndex((f) => f.id === activeFieldId) >= profile.fields.length - 1}
                  onClick={() => {
                    const idx = profile.fields.findIndex((f) => f.id === activeFieldId);
                    if (idx < profile.fields.length - 1) setActiveFieldId(profile.fields[idx + 1].id);
                  }}
                  className="px-2.5 py-1 rounded border border-neutral-200 bg-white hover:bg-neutral-100 disabled:opacity-30"
                >
                  Next Field
                </button>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
};
