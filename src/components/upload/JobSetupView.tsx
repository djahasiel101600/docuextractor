/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
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

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeProfile = profiles.find((p) => p.id === selectedProfileId) || profiles[0];

  // Handle uploaded files (ZIP or loose PDFs)
  const handleFiles = async (files: FileList | File[]) => {
    if (!files || files.length === 0) return;
    setIsUnpacking(true);
    setUnpackError(null);

    try {
      const firstFile = files[0];
      const isZip = firstFile.name.toLowerCase().endsWith('.zip');

      if (isZip) {
        const result = await unpackZipArchive(firstFile, firstFile.name);
        setArchiveResult(result);
      } else {
        // Multiple loose PDF files
        const fileArray = Array.from(files);
        const result = await collectLoosePdfFiles(fileArray);
        setArchiveResult(result);
      }
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

          {/* Quick Demo Button */}
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

            {archiveResult.unsupportedFiles.length > 0 && (
              <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-md flex items-center gap-1.5">
                <FileWarning className="w-3.5 h-3.5" />
                <span>{archiveResult.unsupportedFiles.length} unsupported non-PDFs ignored</span>
              </span>
            )}
          </div>

          {/* Discovered files list preview */}
          <div className="border border-neutral-200 rounded-lg overflow-hidden max-h-56 overflow-y-auto divide-y divide-neutral-100 text-xs">
            {archiveResult.pdfFiles.map((file) => (
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
            ))}
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
