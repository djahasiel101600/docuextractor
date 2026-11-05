/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  FileArchive,
  Sparkles,
  Sliders,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  FolderTree,
  ArrowRight,
  ShieldCheck,
  Cpu,
} from 'lucide-react';
import { ProcessingJob, ExtractionProfile } from '../../types/extraction';
import { ActiveTab } from '../layout/Header';

interface DashboardViewProps {
  jobs: ProcessingJob[];
  profiles: ExtractionProfile[];
  onNavigate: (tab: ActiveTab) => void;
  onLoadDemo: () => void;
  onSelectJob: (job: ProcessingJob) => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  jobs,
  profiles,
  onNavigate,
  onLoadDemo,
  onSelectJob,
}) => {
  const latestJob = jobs[0];

  // Aggregate stats across all jobs
  const totalFilesProcessed = jobs.reduce((acc, j) => acc + j.documents.length, 0);
  const totalReviewed = jobs.reduce(
    (acc, j) => acc + j.documents.filter((d) => d.isReviewed).length,
    0
  );
  const totalConflicts = jobs.reduce(
    (acc, j) =>
      acc +
      j.documents.filter((d) => Object.values(d.diagnostics).some((diag) => diag.isConflict)).length,
    0
  );

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      
      {/* Hero Welcome Banner */}
      <div className="bg-white rounded-xl border border-neutral-200 p-6 md:p-8 shadow-xs">
        <div className="max-w-2xl space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-neutral-500 uppercase tracking-wider">
            <span>High-Throughput PDF Extraction Workstation</span>
          </div>
          <h1 className="text-2xl md:text-3xl font-extrabold text-neutral-900 tracking-tight">
            Bulk PDF Data Extraction, Validation &amp; Dual-Report System
          </h1>
          <p className="text-sm text-neutral-600 leading-relaxed">
            Extract structured datasets from digitally completed forms and filenames. Compare multi-source values, flag discrepancies, run fallback OCR for low-text scans, and export both clean datasets and full diagnostic audit traces.
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              onClick={() => onNavigate('new-job')}
              className="flex items-center gap-2 px-4 py-2 text-xs font-bold text-white bg-neutral-900 hover:bg-neutral-800 rounded-md transition-colors"
            >
              <FileArchive className="w-4 h-4" />
              <span>Upload ZIP Archive</span>
            </button>
            <button
              onClick={onLoadDemo}
              className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-neutral-800 bg-neutral-100 hover:bg-neutral-200 rounded-md transition-colors border border-neutral-200"
            >
              <Sparkles className="w-4 h-4 text-neutral-700" />
              <span>Load Realistic Sample Archive (8 PDFs)</span>
            </button>
          </div>
        </div>
      </div>

      {/* Aggregate Lifetime Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-neutral-200 p-5 shadow-xs">
          <span className="text-xs font-medium text-neutral-500 block">Total Documents Processed</span>
          <span className="text-2xl font-extrabold text-neutral-900 font-mono tabular-nums mt-1 block">
            {totalFilesProcessed}
          </span>
          <span className="text-[11px] text-neutral-400 mt-1 block">Across {jobs.length} batch job(s)</span>
        </div>

        <div className="bg-white rounded-xl border border-neutral-200 p-5 shadow-xs">
          <span className="text-xs font-medium text-neutral-500 block">Active Extraction Profiles</span>
          <span className="text-2xl font-extrabold text-neutral-900 font-mono tabular-nums mt-1 block">
            {profiles.length}
          </span>
          <span className="text-[11px] text-neutral-400 mt-1 block">Custom rules &amp; validators</span>
        </div>

        <div className="bg-white rounded-xl border border-neutral-200 p-5 shadow-xs">
          <span className="text-xs font-medium text-neutral-500 block">Flagged Discrepancies</span>
          <span className="text-2xl font-extrabold text-amber-700 font-mono tabular-nums mt-1 block">
            {totalConflicts}
          </span>
          <span className="text-[11px] text-neutral-400 mt-1 block">Protected from silent overwrite</span>
        </div>

        <div className="bg-white rounded-xl border border-neutral-200 p-5 shadow-xs">
          <span className="text-xs font-medium text-neutral-500 block">Verified &amp; Reviewed</span>
          <span className="text-2xl font-extrabold text-emerald-700 font-mono tabular-nums mt-1 block">
            {totalReviewed}
          </span>
          <span className="text-[11px] text-neutral-400 mt-1 block">Audited documents</span>
        </div>
      </div>

      {/* Latest Processing Job Quick Access (if any) */}
      {latestJob && (
        <div className="bg-white rounded-xl border border-neutral-200 p-6 shadow-xs space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-neutral-100">
            <div>
              <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider block">
                Most Recent Batch Job
              </span>
              <h3 className="text-base font-bold text-neutral-900 mt-0.5">
                {latestJob.zipFilename}
              </h3>
            </div>
            <button
              onClick={() => {
                onSelectJob(latestJob);
                onNavigate('results');
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-md transition-colors"
            >
              <span>Inspect Results</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
            <div>
              <span className="text-neutral-400 block text-[11px]">Discovered PDFs:</span>
              <span className="font-semibold text-neutral-800 font-mono">
                {latestJob.documents.length}
              </span>
            </div>
            <div>
              <span className="text-neutral-400 block text-[11px]">Profile Applied:</span>
              <span className="font-semibold text-neutral-800">
                {latestJob.profileName}
              </span>
            </div>
            <div>
              <span className="text-neutral-400 block text-[11px]">Date Executed:</span>
              <span className="font-semibold text-neutral-800 font-mono">
                {new Date(latestJob.createdAt).toLocaleDateString()}
              </span>
            </div>
            <div>
              <span className="text-neutral-400 block text-[11px]">Review Progress:</span>
              <span className="font-semibold text-neutral-800 font-mono">
                {latestJob.documents.filter((d) => d.isReviewed).length} / {latestJob.documents.length} reviewed
              </span>
            </div>
          </div>
        </div>
      )}

      {/* System Architectural Principles Bento */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="bg-white rounded-xl border border-neutral-200 p-5 shadow-xs space-y-2.5">
          <div className="w-8 h-8 rounded-lg bg-neutral-100 text-neutral-800 flex items-center justify-center font-bold">
            <Cpu className="w-4 h-4" />
          </div>
          <h4 className="text-sm font-bold text-neutral-900">
            Native PDF &amp; Spatial Parsing
          </h4>
          <p className="text-xs text-neutral-600 leading-relaxed">
            Prioritizes native digital PDF text tokens and spatial coordinates. Employs Tesseract OCR only when documents have insufficient text or are rasterized scans.
          </p>
        </div>

        <div className="bg-white rounded-xl border border-neutral-200 p-5 shadow-xs space-y-2.5">
          <div className="w-8 h-8 rounded-lg bg-neutral-100 text-neutral-800 flex items-center justify-center font-bold">
            <ShieldCheck className="w-4 h-4" />
          </div>
          <h4 className="text-sm font-bold text-neutral-900">
            Zero Silent Overwrites
          </h4>
          <p className="text-xs text-neutral-600 leading-relaxed">
            When filename regex and PDF content differ (e.g. status mismatch), the system flags the conflict, preserves both original values, and requires verification.
          </p>
        </div>

        <div className="bg-white rounded-xl border border-neutral-200 p-5 shadow-xs space-y-2.5">
          <div className="w-8 h-8 rounded-lg bg-neutral-100 text-neutral-800 flex items-center justify-center font-bold">
            <FileSpreadsheet className="w-4 h-4" />
          </div>
          <h4 className="text-sm font-bold text-neutral-900">
            Dual CSV Audit Reports
          </h4>
          <p className="text-xs text-neutral-600 leading-relaxed">
            Exports both a clean reconciled primary dataset and a line-by-line diagnostics trace complete with matched labels, confidence scores, and textual evidence.
          </p>
        </div>
      </div>

    </div>
  );
};
