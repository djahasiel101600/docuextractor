/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Suspense, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { Header, ActiveTab } from './components/layout/Header';
import { DashboardView } from './components/dashboard/DashboardView';
import { JobSetupView } from './components/upload/JobSetupView';
import { ResultsTableView } from './components/results/ResultsTableView';
import { CsvExportModal } from './components/export/CsvExportModal';
import { ProfilesView } from './components/profiles/ProfilesView';
import { HistoryView } from './components/history/HistoryView';
import { DEFAULT_PROFILES } from './data/defaultProfiles';
import {
  ProcessingJob,
  ExtractionProfile,
  PDFDocumentRecord,
} from './types/extraction';
import { ArchiveDiscoveryResult } from './services/zipService';
import {
  createBatchJob,
  createJob,
  createProfile,
  deleteJob as deleteServerJob,
  deleteProfile as deleteServerProfile,
  getJob,
  getJobProgress,
  getApiErrorMessage,
  getDocumentFile,
  listJobs,
  listProfiles,
  startJob,
  updateDocumentField,
  updateDocumentReview,
  updateProfile,
  uploadJobArchive,
} from './services/apiClient';
import { createDemoZipArchive } from './services/sampleArchiveGenerator';

const DocumentInspectorModal = React.lazy(() =>
  import('./components/results/DocumentInspectorModal').then((module) => ({
    default: module.DocumentInspectorModal,
  }))
);

const PROFILE_STORAGE_KEY = 'docuextract_profiles_v1';
const ACTIVE_JOB_STORAGE_KEY = 'docuextract_active_job_id_v1';
const TAB_PATHS: Record<ActiveTab, string> = {
  dashboard: '/',
  'new-job': '/jobs/new',
  results: '/results',
  profiles: '/profiles',
  history: '/history',
};

interface WorkspaceData {
  profiles: ExtractionProfile[];
  jobs: ProcessingJob[];
}

function isExtractionProfile(value: unknown): value is ExtractionProfile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'fields' in value &&
    Array.isArray(value.fields) &&
    'ocrSettings' in value &&
    typeof value.ocrSettings === 'object' &&
    value.ocrSettings !== null
  );
}

function readLegacyProfiles(): ExtractionProfile[] {
  let stored: string | null;
  try {
    stored = localStorage.getItem(PROFILE_STORAGE_KEY);
  } catch (error) {
    throw new Error(`Could not read the saved extraction profiles: ${getApiErrorMessage(error)}`);
  }
  if (!stored) {
    return DEFAULT_PROFILES;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch (error) {
    throw new Error(`Saved extraction profiles are not valid JSON: ${getApiErrorMessage(error)}`);
  }
  if (!Array.isArray(parsed) || !parsed.every(isExtractionProfile)) {
    throw new Error('Saved extraction profiles have an invalid format; the original data was left untouched.');
  }
  return parsed;
}

async function loadWorkspace(): Promise<WorkspaceData> {
  let profiles = await listProfiles();
  if (profiles.length === 0) {
    const savedProfiles = readLegacyProfiles();
    for (const profile of savedProfiles) {
      await createProfile(profile);
    }
    profiles = await listProfiles();
  }
  const jobs = await listJobs();
  return { profiles, jobs };
}

function readStoredActiveJobId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_JOB_STORAGE_KEY);
  } catch {
    return null;
  }
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) {
    return 'Calculating...';
  }
  const totalSeconds = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function replaceDocument(
  currentJobs: ProcessingJob[],
  updatedDocument: PDFDocumentRecord
): ProcessingJob[] {
  return currentJobs.map((job) =>
    job.id === updatedDocument.jobId
      ? {
        ...job,
        documents: job.documents.map((document) =>
          document.id === updatedDocument.id ? updatedDocument : document
        ),
      }
      : job
  );
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const workspaceQuery = useQuery({
    queryKey: ['workspace'],
    queryFn: loadWorkspace,
    staleTime: Infinity,
  });
  const [profiles, setProfiles] = useState<ExtractionProfile[]>([]);
  const [jobs, setJobs] = useState<ProcessingJob[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [activeJobId, setActiveJobId] = useState<string | null>(() =>
    readStoredActiveJobId()
  );
  const [inspectingDoc, setInspectingDoc] = useState<PDFDocumentRecord | null>(null);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [exportJobOverride, setExportJobOverride] = useState<ProcessingJob | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [processingProgress, setProcessingProgress] = useState<{
    phase: 'uploading' | 'processing';
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
  } | null>(null);

  useEffect(() => {
    if (!workspaceQuery.data) {
      return;
    }
    setProfiles(workspaceQuery.data.profiles);
    setJobs(workspaceQuery.data.jobs);
    setSelectedProfileId((current) =>
      workspaceQuery.data.profiles.some((profile) => profile.id === current)
        ? current
        : workspaceQuery.data.profiles[0]?.id || ''
    );
    setActiveJobId((current) => {
      if (workspaceQuery.data.jobs.some((job) => job.id === current)) {
        return current;
      }
      // Prefer a still-running batch so a reload resumes watching it live.
      const running = workspaceQuery.data.jobs.find(
        (job) => job.status === 'running'
      );
      return running?.id ?? workspaceQuery.data.jobs[0]?.id ?? null;
    });
  }, [workspaceQuery.data]);

  const runningJobId =
    jobs.find((job) => job.status === 'running')?.id ?? null;

  // Remember the focused job across reloads.
  useEffect(() => {
    if (!activeJobId) {
      return;
    }
    try {
      localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, activeJobId);
    } catch {
      // Ignore storage quota / privacy-mode failures.
    }
  }, [activeJobId]);

  // Central job watcher. While a batch is running we poll it on an interval so
  // that (a) partial results stream into every view and (b) progress survives a
  // page reload or tab switch, independent of the request that started it.
  useEffect(() => {
    if (!runningJobId) {
      setIsProcessing(false);
      setProcessingProgress(null);
      return;
    }
    let cancelled = false;
    setIsProcessing(true);
    const tick = async () => {
      try {
        const [progress, detail] = await Promise.all([
          getJobProgress(runningJobId),
          getJob(runningJobId),
        ]);
        if (cancelled) {
          return;
        }
        setJobs((current) =>
          current.map((job) => (job.id === detail.id ? detail : job))
        );
        setProcessingProgress({
          phase: 'processing',
          total: progress.totalDiscovered,
          completed: progress.processedCount,
          failed: progress.failedCount,
          skipped: progress.skippedCount ?? 0,
          currentFile:
            progress.currentProcessingFiles.join(', ') ||
            'Preparing next document...',
          uploadPercent: 100,
          remaining: progress.remainingCount,
          currentFiles: progress.currentProcessingFiles,
          elapsedSeconds: progress.elapsedSeconds,
          averageSecondsPerDocument: progress.averageSecondsPerDocument,
          estimatedRemainingSeconds: progress.estimatedRemainingSeconds,
          workerCount: progress.workerCount,
        });
      } catch (error) {
        if (!cancelled) {
          setWorkspaceError(
            `Lost contact with the running job: ${getApiErrorMessage(error)}`
          );
        }
      }
    };
    void tick();
    const interval = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [runningJobId]);

  const activeTab =
    (Object.entries(TAB_PATHS).find(([, path]) => path === location.pathname)?.[0] as
      | ActiveTab
      | undefined) || 'dashboard';
  const setActiveTab = (tab: ActiveTab) => navigate(TAB_PATHS[tab]);

  const activeJob = jobs.find((job) => job.id === activeJobId) || jobs[0] || null;
  const activeProfile =
    profiles.find((profile) => profile.id === (activeJob?.profileId || selectedProfileId)) ||
    profiles[0] ||
    DEFAULT_PROFILES[0];

  // The inspector must open the profile this document was actually extracted
  // with. A batch can mix profiles, so the document's own assignment wins and
  // the job default is only the fallback the backend pipeline itself uses.
  const inspectingDocJob = inspectingDoc
    ? jobs.find((job) => job.documents.some((item) => item.id === inspectingDoc.id))
    : undefined;
  const inspectingProfile =
    (inspectingDoc &&
      (profiles.find((profile) => profile.id === inspectingDoc.profileId) ||
        profiles.find((profile) => profile.id === inspectingDocJob?.profileId))) ||
    activeProfile;

  const handleStartProcessing = async (
    archiveResult: ArchiveDiscoveryResult,
    profile: ExtractionProfile,
    existingJobId?: string
  ) => {
    setWorkspaceError(null);
    setIsProcessing(true);
    setProcessingProgress({
      phase: 'uploading',
      total: archiveResult.pdfFiles.length,
      completed: 0,
      failed: 0,
      skipped: 0,
      currentFile: 'Uploading archive to the local processing service...',
      uploadPercent: 0,
      remaining: archiveResult.pdfFiles.length,
      currentFiles: [],
      elapsedSeconds: 0,
      averageSecondsPerDocument: null,
      estimatedRemainingSeconds: null,
      workerCount: 1,
    });

    try {
      // When documents were already analysed, an idle batch job was created
      // up-front. Just start that existing job instead of creating a duplicate.
      if (existingJobId) {
        const started = await startJob(existingJobId);
        setJobs((current) => [
          started,
          ...current.filter((existing) => existing.id !== started.id),
        ]);
        setActiveJobId(started.id);
        setActiveTab('results');
        if (started.status !== 'running') {
          const detail = await getJob(started.id);
          setJobs((current) =>
            current.map((existing) => (existing.id === detail.id ? detail : existing))
          );
          setIsProcessing(false);
          setProcessingProgress(null);
          if (detail.status === 'error') {
            setWorkspaceError('The archive processing job failed. Review the job details for documents that could not be processed.');
          }
        }
        return;
      }

      const batchArchives = archiveResult.sourceArchives ?? [];
      if (batchArchives.length > 1) {
        await handleStartBatchProcessing(archiveResult, profile, batchArchives);
        return;
      }
      const job = await createJob(
        archiveResult.sourceFile,
        archiveResult.zipName,
        profile.id,
        (uploadPercent) => {
          setProcessingProgress((current) =>
            current?.phase === 'uploading' ? { ...current, uploadPercent } : current
          );
        }
      );
      setJobs((current) => [job, ...current]);
      setActiveJobId(job.id);
      // The central watcher polls while the job is 'running', streaming partial
      // results into the Results view. Show it immediately.
      setActiveTab('results');
      if (job.status !== 'running') {
        // Tiny archive finished before we could poll; load its final detail.
        const detail = await getJob(job.id);
        setJobs((current) =>
          current.map((existing) => (existing.id === detail.id ? detail : existing))
        );
        setIsProcessing(false);
        setProcessingProgress(null);
        if (detail.status === 'error') {
          setWorkspaceError('The archive processing job failed. Review the job details for documents that could not be processed.');
        }
      }
    } catch (error) {
      setWorkspaceError(`Could not process the archive: ${getApiErrorMessage(error)}`);
      setIsProcessing(false);
      setProcessingProgress(null);
    }
  };

  // Batch-upload flow: one idle job is created up front, then every archive is
  // uploaded as its own small multipart request (so no single HTTP body hits
  // the proxy/tunnel size caps that stall large single-zip uploads). Failed
  // archives are collected as non-fatal warnings; the remaining ones still
  // process. If nothing could be uploaded we delete the job so no orphan is
  // left behind (the backend also refuses to start - and cleans up - a job
  // with zero documents).
  const handleStartBatchProcessing = async (
    archiveResult: ArchiveDiscoveryResult,
    profile: ExtractionProfile,
    batchArchives: { filename: string; blob: Blob }[]
  ) => {
    const total = batchArchives.length;
    const setPhase = (currentFile: string, uploadPercent: number) =>
      setProcessingProgress((current) =>
        current?.phase === 'uploading'
          ? { ...current, currentFile, uploadPercent }
          : current
      );

    setPhase(`Creating batch job...`, 0);
    const job = await createBatchJob(profile.id);

    const failedArchives: string[] = [];
    for (let index = 0; index < total; index += 1) {
      const archive = batchArchives[index];
      setPhase(
        `Uploading archive ${index + 1} of ${total}: ${archive.filename}`,
        Math.round(((index + 0.01) / total) * 100)
      );
      try {
        await uploadJobArchive(
          job.id,
          archive.blob,
          archive.filename,
          (percent) =>
            setPhase(
              `Uploading archive ${index + 1} of ${total}: ${archive.filename}`,
              Math.round(((index + percent / 100) / total) * 100)
            )
        );
      } catch (error) {
        // Non-fatal: keep the archives already accepted and try the rest.
        failedArchives.push(`${archive.filename} (${getApiErrorMessage(error)})`);
      }
    }

    if (failedArchives.length === total) {
      // Nothing was accepted; the idle job has no documents - delete it so it
      // never lingers as an orphan, then surface the combined error.
      try {
        await deleteServerJob(job.id);
      } catch {
        // Best-effort cleanup only.
      }
      throw new Error(
        `None of the ${total} archives could be uploaded: ${failedArchives.join('; ')}`
      );
    }

    setPhase(
      failedArchives.length
        ? `Starting processing (${failedArchives.length} archive(s) skipped)...`
        : 'Starting processing...',
      100
    );
    try {
      const started = await startJob(job.id);
      setJobs((current) => [
        started,
        ...current.filter((existing) => existing.id !== started.id),
      ]);
      setActiveJobId(started.id);
      setActiveTab('results');
      if (failedArchives.length) {
        setWorkspaceError(
          `Processing started, but ${failedArchives.length} archive(s) failed to upload and were skipped: ${failedArchives.join('; ')}`
        );
      }
      if (started.status !== 'running') {
        // All documents finished before the watcher polled; load final detail.
        const detail = await getJob(started.id);
        setJobs((current) =>
          current.map((existing) => (existing.id === detail.id ? detail : existing))
        );
        setIsProcessing(false);
        setProcessingProgress(null);
        if (detail.status === 'error') {
          setWorkspaceError('The archive processing job failed. Review the job details for documents that could not be processed.');
        }
      }
      // Otherwise the central watcher takes over polling via runningJobId.
    } catch (error) {
      // Cleanup depends on the job state: if start itself failed and the job
      // still exists it is 'idle' with zero or rejected documents, so delete
      // it. A 404 here means the backend already cleaned the job up.
      try {
        await deleteServerJob(job.id);
      } catch {
        // Ignore: already deleted or not reachable.
      }
      throw new Error(
        `Could not start the batch job: ${getApiErrorMessage(error)}`
      );
    }
  };

  const handleLoadAndRunDemo = async () => {
    setWorkspaceError(null);
    try {
      const demoBlob = await createDemoZipArchive();
      const file = new File([demoBlob], 'batch_2026_q1_civil_forms.zip', {
        type: 'application/zip',
      });
      await handleStartProcessing(
        {
          zipName: file.name,
          totalFiles: 0,
          pdfFiles: [],
          unsupportedFiles: [],
          corruptedFiles: [],
          zipSizeBytes: file.size,
          sourceFile: file,
        },
        profiles.find((profile) => profile.id === 'profile-gov-forms') || activeProfile
      );
    } catch (error) {
      setWorkspaceError(`Could not create the sample archive: ${getApiErrorMessage(error)}`);
    }
  };

  const handleInspectDocument = async (document: PDFDocumentRecord) => {
    setWorkspaceError(null);
    try {
      const fileData = document.fileData || (await getDocumentFile(document));
      setInspectingDoc({ ...document, fileData });
    } catch (error) {
      setWorkspaceError(`Could not open ${document.filename}: ${getApiErrorMessage(error)}`);
    }
  };

  const handleUpdateFieldValue = (
    documentId: string,
    fieldId: string,
    newValue: string
  ) => {
    void updateDocumentField(documentId, fieldId, newValue)
      .then((updatedDocument) => {
        setJobs((current) => replaceDocument(current, updatedDocument));
        setInspectingDoc((current) =>
          current?.id === updatedDocument.id
            ? { ...updatedDocument, fileData: current.fileData }
            : current
        );
      })
      .catch((error: unknown) => {
        setWorkspaceError(`Could not save the field correction: ${getApiErrorMessage(error)}`);
      });
  };

  const handleToggleReviewed = (documentId: string) => {
    const document = jobs
      .flatMap((job) => job.documents)
      .find((item) => item.id === documentId);
    if (!document) {
      setWorkspaceError('The selected document is no longer available.');
      return;
    }

    void updateDocumentReview(documentId, !document.isReviewed)
      .then((updatedDocument) => {
        setJobs((current) => replaceDocument(current, updatedDocument));
        setInspectingDoc((current) =>
          current?.id === updatedDocument.id
            ? { ...updatedDocument, fileData: current.fileData }
            : current
        );
      })
      .catch((error: unknown) => {
        setWorkspaceError(`Could not update the document review status: ${getApiErrorMessage(error)}`);
      });
  };

  const handleSaveProfile = (profileToSave: ExtractionProfile) => {
    const alreadyExists = profiles.some((profile) => profile.id === profileToSave.id);
    const saveRequest = alreadyExists
      ? updateProfile(profileToSave)
      : createProfile(profileToSave);
    void saveRequest
      .then((savedProfile) => {
        setProfiles((current) =>
          alreadyExists
            ? current.map((profile) =>
              profile.id === savedProfile.id ? savedProfile : profile
            )
            : [...current, savedProfile]
        );
      })
      .catch((error: unknown) => {
        setWorkspaceError(`Could not save the extraction profile: ${getApiErrorMessage(error)}`);
      });
  };

  const handleDeleteProfile = (profileId: string) => {
    void deleteServerProfile(profileId)
      .then(() => {
        setProfiles((current) => current.filter((profile) => profile.id !== profileId));
        setSelectedProfileId((current) =>
          current === profileId
            ? profiles.find((profile) => profile.id !== profileId)?.id || ''
            : current
        );
      })
      .catch((error: unknown) => {
        setWorkspaceError(`Could not delete the extraction profile: ${getApiErrorMessage(error)}`);
      });
  };

  const handleDuplicateProfile = (source: ExtractionProfile) => {
    const now = new Date().toISOString();
    const duplicate: ExtractionProfile = {
      ...source,
      id: `profile-${Date.now()}`,
      name: `${source.name} (Copy)`,
      createdAt: now,
      updatedAt: now,
    };
    void createProfile(duplicate)
      .then((savedProfile) => {
        setProfiles((current) => [...current, savedProfile]);
        setSelectedProfileId(savedProfile.id);
      })
      .catch((error: unknown) => {
        setWorkspaceError(`Could not duplicate the extraction profile: ${getApiErrorMessage(error)}`);
      });
  };

  const handleDeleteJob = (jobId: string) => {
    void deleteServerJob(jobId)
      .then(() => {
        setJobs((current) => current.filter((job) => job.id !== jobId));
        setActiveJobId((current) => {
          if (current !== jobId) {
            return current;
          }
          return jobs.find((job) => job.id !== jobId)?.id || null;
        });
      })
      .catch((error: unknown) => {
        setWorkspaceError(`Could not delete the processing job: ${getApiErrorMessage(error)}`);
      });
  };

  const handleOpenExportForJob = (targetJob: ProcessingJob) => {
    setExportJobOverride(targetJob);
    setIsExportModalOpen(true);
  };
  const handleOpenExportDefault = () => {
    setExportJobOverride(null);
    setIsExportModalOpen(true);
  };
  const exportTargetJob = exportJobOverride || activeJob;

  if (workspaceQuery.isLoading) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-neutral-50 text-sm text-neutral-600">
        Connecting to the local document service...
      </main>
    );
  }

  if (workspaceQuery.isError) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-neutral-50 p-6">
        <div className="max-w-xl rounded-xl border border-rose-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-bold text-neutral-900">Local service unavailable</h1>
          <p className="mt-2 text-sm text-neutral-600">
            {getApiErrorMessage(workspaceQuery.error)}
          </p>
          <p className="mt-2 text-sm text-neutral-600">
            Start Django with <code>npm run backend:dev</code>, then retry.
          </p>
          <button
            onClick={() => void workspaceQuery.refetch()}
            className="mt-4 rounded-md bg-neutral-900 px-4 py-2 text-sm font-semibold text-white"
          >
            Retry connection
          </button>
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-neutral-50 text-neutral-900 font-sans">
      <Header
        activeTab={activeTab}
        onTabChange={setActiveTab}
        hasActiveJob={Boolean(activeJob)}
        onOpenExport={handleOpenExportDefault}
      />

      <main className="flex-1 p-6 md:p-8 max-w-7xl mx-auto w-full">
        {processingProgress &&
          (runningJobId || processingProgress.phase === 'uploading') &&
          (() => {
            const p = processingProgress;
            // Excluded documents never enter the extraction queue, so they have
            // to count as settled or the bar would stall short of 100%.
            const processedCount = p.completed + p.failed + p.skipped;
            const percent =
              p.phase === 'uploading'
                ? p.uploadPercent
                : p.total > 0
                  ? Math.round((processedCount / p.total) * 100)
                  : 0;
            return (
              <div
                role="status"
                aria-live="polite"
                className="mb-5 rounded-xl border border-neutral-200 bg-white p-4 shadow-xs"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="inline-block w-4 h-4 rounded-full border-2 border-neutral-300 border-t-neutral-900 animate-spin shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-neutral-900 truncate">
                        {p.phase === 'uploading'
                          ? `Uploading archive (${p.uploadPercent}%)`
                          : `Processing batch live — ${processedCount} / ${p.total} documents`}
                      </p>
                      <p className="text-xs text-neutral-500 font-mono truncate">
                        Current: {p.currentFile}
                      </p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-sm font-mono font-bold text-neutral-900 tabular-nums">
                      {percent}%
                    </span>
                    {p.phase === 'processing' && (
                      <p className="text-[11px] text-neutral-500 font-mono">
                        ETA {formatDuration(p.estimatedRemainingSeconds)}
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-3 w-full h-2 bg-neutral-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-neutral-900 transition-all duration-300"
                    style={{ width: `${percent}%` }}
                  />
                </div>
                {p.phase === 'processing' && (
                  <p className="mt-2 text-[11px] text-neutral-500 font-mono">
                    Completed {p.completed} · Failed {p.failed} ·{' '}
                    {p.skipped > 0 ? `Skipped ${p.skipped} · ` : ''}Remaining{' '}
                    {p.remaining} · Workers {p.workerCount} · Elapsed{' '}
                    {formatDuration(p.elapsedSeconds)} · Avg{' '}
                    {formatDuration(p.averageSecondsPerDocument)}/doc. Results
                    stream in below as documents finish.
                  </p>
                )}
              </div>
            );
          })()}
        {workspaceError && (
          <div
            role="alert"
            className="mb-5 flex items-start justify-between gap-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900"
          >
            <span>{workspaceError}</span>
            <button
              onClick={() => setWorkspaceError(null)}
              className="shrink-0 font-semibold underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {activeTab === 'dashboard' && (
          <DashboardView
            jobs={jobs}
            profiles={profiles}
            onNavigate={setActiveTab}
            onLoadDemo={handleLoadAndRunDemo}
            onSelectJob={(job) => {
              setActiveJobId(job.id);
              setActiveTab('results');
            }}
          />
        )}

        {activeTab === 'new-job' && (
          <JobSetupView
            profiles={profiles}
            selectedProfileId={selectedProfileId}
            onSelectProfileId={setSelectedProfileId}
            onStartProcessing={handleStartProcessing}
            isProcessing={isProcessing}
            processingProgress={processingProgress}
          />
        )}

        {activeTab === 'results' && (
          <>
            {activeJob ? (
              <ResultsTableView
                job={activeJob}
                profiles={profiles}
                onInspectDocument={handleInspectDocument}
                onToggleReviewed={handleToggleReviewed}
                onUpdateFieldValue={handleUpdateFieldValue}
                onOpenExport={handleOpenExportDefault}
              />
            ) : (
              <div className="mx-auto max-w-2xl space-y-4 rounded-xl border border-neutral-200 bg-white p-12 text-center shadow-xs">
                <h3 className="text-base font-bold text-neutral-900">
                  No Active Extraction Job
                </h3>
                <p className="text-xs text-neutral-500">
                  You haven&apos;t processed a document batch yet. Upload an archive or run our sample fixture to inspect results.
                </p>
                <div className="flex items-center justify-center gap-3 pt-2">
                  <button
                    onClick={() => setActiveTab('new-job')}
                    className="rounded-md bg-neutral-900 px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-neutral-800"
                  >
                    Upload Archive
                  </button>
                  <button
                    onClick={handleLoadAndRunDemo}
                    className="rounded-md border border-neutral-200 bg-neutral-100 px-4 py-2 text-xs font-semibold text-neutral-800 transition-colors hover:bg-neutral-200"
                  >
                    Load Realistic Demo Archive
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {activeTab === 'profiles' && (
          <ProfilesView
            profiles={profiles}
            onSaveProfile={handleSaveProfile}
            onDeleteProfile={handleDeleteProfile}
            onDuplicateProfile={handleDuplicateProfile}
          />
        )}

        {activeTab === 'history' && (
          <HistoryView
            jobs={jobs}
            onSelectJob={(job) => setActiveJobId(job.id)}
            onNavigate={setActiveTab}
            onOpenExportForJob={handleOpenExportForJob}
            onDeleteJob={handleDeleteJob}
            onLoadDemo={handleLoadAndRunDemo}
          />
        )}
      </main>

      {inspectingDoc && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/60 text-sm text-white">
              Loading PDF preview...
            </div>
          }
        >
          <DocumentInspectorModal
            key={inspectingDoc.id}
            document={inspectingDoc}
            profile={inspectingProfile}
            onClose={() => setInspectingDoc(null)}
            onUpdateFieldValue={handleUpdateFieldValue}
            onToggleReviewed={handleToggleReviewed}
          />
        </Suspense>
      )}

      {isExportModalOpen && exportTargetJob && (
        <CsvExportModal
          job={exportTargetJob}
          profile={profiles.find((profile) => profile.id === exportTargetJob.profileId) || activeProfile}
          profiles={profiles}
          onClose={() => {
            setIsExportModalOpen(false);
            setExportJobOverride(null);
          }}
        />
      )}
    </div>
  );
}
