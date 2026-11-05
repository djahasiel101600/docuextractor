/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from 'react';
import {
  X,
  Download,
  FileSpreadsheet,
  Check,
  SlidersHorizontal,
  Copy,
  CheckCheck,
} from 'lucide-react';
import { ProcessingJob, ExtractionProfile } from '../../types/extraction';
import {
  generatePrimaryCsv,
  generateDiagnosticsCsv,
  CsvDelimiter,
} from '../../services/csvExportService';
import {downloadJobExport, getApiErrorMessage} from '../../services/apiClient';

interface CsvExportModalProps {
  job: ProcessingJob;
  profile: ExtractionProfile;
  onClose: () => void;
}

export const CsvExportModal: React.FC<CsvExportModalProps> = ({ job, profile, onClose }) => {
  const [activeTab, setActiveTab] = useState<'primary' | 'diagnostics'>('primary');
  const [delimiter, setDelimiter] = useState<CsvDelimiter>(',');
  const [includeBom, setIncludeBom] = useState<boolean>(true);
  const [useCorrectedValues, setUseCorrectedValues] = useState<boolean>(true);
  const [onlyReviewed, setOnlyReviewed] = useState<boolean>(false);
  const [selectedFieldIds, setSelectedFieldIds] = useState<string[]>(
    profile.fields.map((f) => f.id)
  );
  const [copied, setCopied] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Filter documents if "Only Reviewed" is checked
  const targetDocs = useMemo(() => {
    return onlyReviewed ? job.documents.filter((d) => d.isReviewed) : job.documents;
  }, [job.documents, onlyReviewed]);

  // Generate previews
  const primaryCsvContent = useMemo(() => {
    return generatePrimaryCsv(targetDocs, profile, {
      delimiter,
      includeBom,
      useCorrectedValues,
      selectedFieldIds,
    });
  }, [targetDocs, profile, delimiter, includeBom, useCorrectedValues, selectedFieldIds]);

  const diagnosticsCsvContent = useMemo(() => {
    return generateDiagnosticsCsv(targetDocs, profile, {
      delimiter,
      includeBom,
      useCorrectedValues,
      selectedFieldIds,
    });
  }, [targetDocs, profile, delimiter, includeBom, useCorrectedValues, selectedFieldIds]);

  const activeCsvContent = activeTab === 'primary' ? primaryCsvContent : diagnosticsCsvContent;

  const handleDownload = async (type: 'primary' | 'diagnostics') => {
    const timestamp = new Date().toISOString().split('T')[0];
    const suffix = type === 'primary' ? 'reconciled' : 'diagnostics_trace';
    const filename = `${job.zipFilename.replace(/\.[^/.]+$/, '')}_${suffix}_${timestamp}.csv`;
    setDownloadError(null);
    setIsDownloading(true);
    try {
      const blob = await downloadJobExport(job.id, type, {
        delimiter: delimiter === ',' ? 'comma' : delimiter === ';' ? 'semicolon' : 'tab',
        includeBom,
        useCorrectedValues,
        onlyReviewed,
        selectedFieldIds,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setDownloadError(`CSV export failed: ${getApiErrorMessage(error)}`);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleCopyClipboard = () => {
    void navigator.clipboard
      .writeText(activeCsvContent)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch((error: unknown) => {
        setDownloadError(`Could not copy the CSV preview: ${getApiErrorMessage(error)}`);
      });
  };

  const toggleFieldSelection = (fieldId: string) => {
    if (selectedFieldIds.includes(fieldId)) {
      setSelectedFieldIds(selectedFieldIds.filter((id) => id !== fieldId));
    } else {
      setSelectedFieldIds([...selectedFieldIds, fieldId]);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-neutral-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl border border-neutral-200 w-full max-w-4xl h-[88vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-98 duration-150">
        
        {/* Top Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 bg-neutral-50/70 shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-neutral-900 text-white">
              <FileSpreadsheet className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-neutral-900">
                Export Extraction Reports to CSV
              </h3>
              <p className="text-xs text-neutral-500">
                Generate reconciled datasets and comprehensive extraction diagnostic traces.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-neutral-500 hover:text-neutral-900 hover:bg-neutral-200 rounded-md transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {downloadError && (
          <div role="alert" className="border-b border-rose-200 bg-rose-50 px-6 py-2 text-xs text-rose-900">
            {downloadError}
          </div>
        )}

        {/* Modal Body */}
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden min-h-0">
          
          {/* Left Column: Export Controls & Field Selector */}
          <div className="w-full md:w-80 border-r border-neutral-200 p-5 overflow-y-auto space-y-5 bg-neutral-50/40 shrink-0">
            {/* Format & Delimiter */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-neutral-700 block">
                CSV Delimiter
              </label>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setDelimiter(',')}
                  className={`py-1.5 px-3 text-xs font-medium rounded-md border text-center transition-colors ${
                    delimiter === ','
                      ? 'bg-neutral-900 text-white border-neutral-900'
                      : 'bg-white text-neutral-700 border-neutral-200 hover:bg-neutral-100'
                  }`}
                >
                  Comma ( , )
                </button>
                <button
                  type="button"
                  onClick={() => setDelimiter(';')}
                  className={`py-1.5 px-3 text-xs font-medium rounded-md border text-center transition-colors ${
                    delimiter === ';'
                      ? 'bg-neutral-900 text-white border-neutral-900'
                      : 'bg-white text-neutral-700 border-neutral-200 hover:bg-neutral-100'
                  }`}
                >
                  Semicolon ( ; )
                </button>
                <button
                  type="button"
                  onClick={() => setDelimiter('\t')}
                  className={`py-1.5 px-3 text-xs font-medium rounded-md border text-center transition-colors ${
                    delimiter === '\t'
                      ? 'bg-neutral-900 text-white border-neutral-900'
                      : 'bg-white text-neutral-700 border-neutral-200 hover:bg-neutral-100'
                  }`}
                >
                  Tab ( \t )
                </button>
              </div>
            </div>

            {/* Encoding & Options */}
            <div className="space-y-2.5 pt-3 border-t border-neutral-200 text-xs">
              <span className="font-semibold text-neutral-700 block">Encoding &amp; Filtering</span>
              
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeBom}
                  onChange={(e) => setIncludeBom(e.target.checked)}
                  className="rounded border-neutral-300 text-neutral-900 focus:ring-neutral-900"
                />
                <span className="text-neutral-700">Include UTF-8 BOM (Excel compatibility)</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={useCorrectedValues}
                  onChange={(e) => setUseCorrectedValues(e.target.checked)}
                  className="rounded border-neutral-300 text-neutral-900 focus:ring-neutral-900"
                />
                <span className="text-neutral-700">Include manual corrections</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={onlyReviewed}
                  onChange={(e) => setOnlyReviewed(e.target.checked)}
                  className="rounded border-neutral-300 text-neutral-900 focus:ring-neutral-900"
                />
                <span className="text-neutral-700">
                  Export only reviewed documents ({job.documents.filter((d) => d.isReviewed).length})
                </span>
              </label>
            </div>

            {/* Field Selection Checklist */}
            <div className="space-y-2 pt-3 border-t border-neutral-200">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-neutral-700">
                  Include Fields ({selectedFieldIds.length}/{profile.fields.length})
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setSelectedFieldIds(
                      selectedFieldIds.length === profile.fields.length
                        ? []
                        : profile.fields.map((f) => f.id)
                    )
                  }
                  className="text-[11px] text-neutral-500 hover:text-neutral-900 underline"
                >
                  {selectedFieldIds.length === profile.fields.length ? 'Deselect All' : 'Select All'}
                </button>
              </div>

              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {profile.fields.map((field) => (
                  <label
                    key={field.id}
                    className="flex items-center gap-2 text-xs text-neutral-700 cursor-pointer hover:bg-neutral-100 p-1.5 rounded"
                  >
                    <input
                      type="checkbox"
                      checked={selectedFieldIds.includes(field.id)}
                      onChange={() => toggleFieldSelection(field.id)}
                      className="rounded border-neutral-300 text-neutral-900 focus:ring-neutral-900"
                    />
                    <span className="truncate">{field.name}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Download Action Buttons */}
            <div className="pt-4 border-t border-neutral-200 space-y-2">
              <button
                type="button"
                onClick={() => void handleDownload('primary')}
                disabled={isDownloading}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-neutral-900 hover:bg-neutral-800 rounded-md transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{isDownloading ? 'Preparing CSV...' : 'Download Primary CSV'}</span>
              </button>

              <button
                type="button"
                onClick={() => void handleDownload('diagnostics')}
                disabled={isDownloading}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-neutral-800 bg-neutral-100 hover:bg-neutral-200 rounded-md transition-colors border border-neutral-200"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download Diagnostics CSV</span>
              </button>
            </div>
          </div>

          {/* Right Column: Live CSV Preview */}
          <div className="flex-1 flex flex-col bg-white overflow-hidden">
            {/* Report Mode Tabs */}
            <div className="flex items-center justify-between px-6 py-3 border-b border-neutral-200 bg-neutral-50/50 shrink-0">
              <div className="flex items-center gap-2 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setActiveTab('primary')}
                  className={`px-3 py-1.5 rounded-md transition-colors ${
                    activeTab === 'primary'
                      ? 'bg-neutral-900 text-white font-semibold'
                      : 'text-neutral-600 hover:text-neutral-900'
                  }`}
                >
                  Primary Reconciled Dataset ({targetDocs.length} rows)
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('diagnostics')}
                  className={`px-3 py-1.5 rounded-md transition-colors ${
                    activeTab === 'diagnostics'
                      ? 'bg-neutral-900 text-white font-semibold'
                      : 'text-neutral-600 hover:text-neutral-900'
                  }`}
                >
                  Diagnostics Trace Report ({targetDocs.length * selectedFieldIds.length} events)
                </button>
              </div>

              <button
                type="button"
                onClick={handleCopyClipboard}
                className="flex items-center gap-1.5 text-xs text-neutral-600 hover:text-neutral-900 border border-neutral-200 rounded px-2.5 py-1 bg-white hover:bg-neutral-50"
              >
                {copied ? <CheckCheck className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Copied' : 'Copy CSV Text'}</span>
              </button>
            </div>

            {/* Preview Box */}
            <div className="flex-1 p-5 overflow-auto bg-neutral-900 text-neutral-200 font-mono text-xs whitespace-pre leading-relaxed select-all">
              {activeCsvContent.replace(/^\uFEFF/, '')}
            </div>

            {/* Footer Summary */}
            <div className="px-6 py-3 border-t border-neutral-200 bg-neutral-50 flex items-center justify-between text-xs text-neutral-500 font-mono shrink-0">
              <span>
                Format: RFC 4180 · Delimiter: &quot;{delimiter === '\t' ? '\\t' : delimiter}&quot; · BOM: {includeBom ? 'Included' : 'None'}
              </span>
              <span>
                {targetDocs.length} documents selected for export
              </span>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
};
