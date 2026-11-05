/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  FileArchive,
  ArrowRight,
  Download,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
} from 'lucide-react';
import { ProcessingJob } from '../../types/extraction';
import { ActiveTab } from '../layout/Header';

interface HistoryViewProps {
  jobs: ProcessingJob[];
  onSelectJob: (job: ProcessingJob) => void;
  onNavigate: (tab: ActiveTab) => void;
  onOpenExportForJob: (job: ProcessingJob) => void;
  onDeleteJob: (jobId: string) => void;
  onLoadDemo: () => void;
}

export const HistoryView: React.FC<HistoryViewProps> = ({
  jobs,
  onSelectJob,
  onNavigate,
  onOpenExportForJob,
  onDeleteJob,
  onLoadDemo,
}) => {
  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between pb-4 border-b border-neutral-200">
        <div>
          <h2 className="text-xl font-bold text-neutral-900 tracking-tight">
            Batch Processing History
          </h2>
          <p className="text-xs text-neutral-500 mt-0.5">
            Audit logs and records of all document batches processed in this workstation session.
          </p>
        </div>

        <button
          onClick={() => onNavigate('new-job')}
          className="px-3.5 py-1.5 text-xs font-semibold text-white bg-neutral-900 hover:bg-neutral-800 rounded-md transition-colors"
        >
          New Processing Job
        </button>
      </div>

      {jobs.length === 0 ? (
        <div className="bg-white rounded-xl border border-neutral-200 p-12 text-center shadow-xs space-y-4">
          <div className="w-12 h-12 rounded-full bg-neutral-100 text-neutral-600 flex items-center justify-center mx-auto">
            <FileArchive className="w-6 h-6" />
          </div>
          <div className="max-w-sm mx-auto space-y-1">
            <h3 className="text-sm font-bold text-neutral-900">
              No Processing History Yet
            </h3>
            <p className="text-xs text-neutral-500">
              Upload a ZIP archive of digital PDF forms or test immediately with our 8-form demo archive.
            </p>
          </div>
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              onClick={() => onNavigate('new-job')}
              className="px-4 py-2 text-xs font-bold text-white bg-neutral-900 hover:bg-neutral-800 rounded-md transition-colors"
            >
              Upload First Batch
            </button>
            <button
              onClick={onLoadDemo}
              className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-neutral-800 bg-neutral-100 hover:bg-neutral-200 rounded-md border border-neutral-200"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Run Sample Demo</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden shadow-xs">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-neutral-50/80 border-b border-neutral-200 text-neutral-600 font-semibold">
                <th className="py-3 px-4">Archive Filename</th>
                <th className="py-3 px-4">Profile Used</th>
                <th className="py-3 px-4">Date Processed</th>
                <th className="py-3 px-4 text-center">Total Documents</th>
                <th className="py-3 px-4 text-center">Conflicts</th>
                <th className="py-3 px-4 text-center">Reviewed</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {jobs.map((job) => {
                const reviewedCount = job.documents.filter((d) => d.isReviewed).length;
                const conflictCount = job.documents.filter((d) =>
                  Object.values(d.diagnostics).some((diag) => diag.isConflict)
                ).length;

                return (
                  <tr key={job.id} className="hover:bg-neutral-50/60 transition-colors">
                    <td className="py-3 px-4 font-semibold text-neutral-900">
                      <div className="flex items-center gap-2">
                        <FileArchive className="w-4 h-4 text-neutral-500" />
                        <span>{job.zipFilename}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-neutral-700">
                      {job.profileName}
                    </td>
                    <td className="py-3 px-4 text-neutral-500 font-mono">
                      {new Date(job.createdAt).toLocaleString()}
                    </td>
                    <td className="py-3 px-4 text-center font-mono tabular-nums font-semibold text-neutral-800">
                      {job.documents.length}
                    </td>
                    <td className="py-3 px-4 text-center">
                      {conflictCount > 0 ? (
                        <span className="text-amber-800 font-bold font-mono px-2 py-0.5 rounded bg-amber-50 border border-amber-200/60">
                          {conflictCount}
                        </span>
                      ) : (
                        <span className="text-neutral-400 font-mono">0</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-center">
                      <span className="text-emerald-800 font-mono font-medium">
                        {reviewedCount} / {job.documents.length}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => {
                            onSelectJob(job);
                            onNavigate('results');
                          }}
                          className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded transition-colors"
                        >
                          <span>Results</span>
                          <ArrowRight className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => onOpenExportForJob(job)}
                          className="p-1 text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 rounded transition-colors"
                          title="Export CSV"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => onDeleteJob(job.id)}
                          className="p-1 text-neutral-400 hover:text-rose-600 hover:bg-rose-50 rounded transition-colors"
                          title="Delete Job"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
