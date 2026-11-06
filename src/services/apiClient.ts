import axios, { AxiosError } from 'axios';
import {
  BlankFormAnalysis,
  ExtractionProfile,
  PDFDocumentRecord,
  ProcessingJob,
  ProcessingJobProgress,
} from '../types/extraction';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 120_000,
});

export async function listProfiles(): Promise<ExtractionProfile[]> {
  const response = await api.get<ExtractionProfile[]>('/profiles/');
  return response.data;
}

export async function createProfile(
  profile: ExtractionProfile
): Promise<ExtractionProfile> {
  const response = await api.post<ExtractionProfile>('/profiles/', profile);
  return response.data;
}

export async function updateProfile(
  profile: ExtractionProfile
): Promise<ExtractionProfile> {
  const response = await api.put<ExtractionProfile>(
    `/profiles/${encodeURIComponent(profile.id)}/`,
    profile
  );
  return response.data;
}

/** Analyze a blank PDF form for the 'Create Profile from Blank Form' wizard. */
export async function analyzeBlankForm(
  file: File
): Promise<BlankFormAnalysis> {
  const formData = new FormData();
  formData.append('file', file, file.name);
  const response = await api.post<BlankFormAnalysis>('/forms/analyze/', formData);
  return response.data;
}

/** Dry-run structural validation; never persists anything. */
export async function validateProfileConfig(
  profile: ExtractionProfile
): Promise<{ valid: boolean; errors: string[] }> {
  const response = await api.post<{ valid: boolean; errors: string[] }>(
    '/forms/validate-profile/',
    profile
  );
  return response.data;
}

export async function testOllamaConnection(
  baseUrl: string,
  model: string,
  timeoutSeconds: number,
  allowCloudModels: boolean
): Promise<string[]> {
  const response = await api.post<{ connected: boolean; models: string[] }>(
    '/ai/ollama/test/',
    { baseUrl, model, timeoutSeconds, allowCloudModels },
    { timeout: (timeoutSeconds * 2 + 5) * 1000 }
  );
  return response.data.models;
}

export async function deleteProfile(profileId: string): Promise<void> {
  await api.delete(`/profiles/${encodeURIComponent(profileId)}/`);
}

export async function listJobs(): Promise<ProcessingJob[]> {
  const response = await api.get<ProcessingJob[]>('/jobs/');
  return response.data;
}

export async function createJob(
  archive: Blob,
  filename: string,
  profileId: string,
  onUploadProgress?: (percent: number) => void
): Promise<ProcessingJob> {
  const formData = new FormData();
  formData.append('file', archive, filename);
  formData.append('profileId', profileId);
  const response = await api.post<ProcessingJob>('/jobs/', formData, {
    timeout: 0,
    onUploadProgress: (progress) => {
      if (progress.total) {
        onUploadProgress?.(Math.round((progress.loaded / progress.total) * 100));
      }
    },
  });
  return response.data;
}

export async function getJobProgress(jobId: string): Promise<ProcessingJobProgress> {
  const response = await api.get<ProcessingJobProgress>(
    `/jobs/${encodeURIComponent(jobId)}/progress/`
  );
  return response.data;
}

/**
 * Batch-upload flow: creates an idle job with no archive attached. Archives
 * are appended one request at a time via uploadJobArchive, then the job is
 * launched with startJob so processing never waits on a single huge body.
 */
export async function createBatchJob(profileId: string): Promise<ProcessingJob> {
  const response = await api.post<ProcessingJob>('/jobs/batch/', { profileId });
  return response.data;
}

/**
 * Uploads one archive into an existing idle job. Each archive is its own
 * small multipart request (timeout disabled) so large batch sets don't hit
 * proxy body-size caps or upload stalls. Throws if the archive is rejected;
 * previously accepted archives are kept server-side.
 */
export async function uploadJobArchive(
  jobId: string,
  archive: Blob,
  filename: string,
  onUploadProgress?: (percent: number) => void
): Promise<{ jobId: string; archive: string; added: number; totalDiscovered: number }> {
  const formData = new FormData();
  formData.append('file', archive, filename);
  const response = await api.post<{
    jobId: string;
    archive: string;
    added: number;
    totalDiscovered: number;
  }>(`/jobs/${encodeURIComponent(jobId)}/archives/`, formData, {
    timeout: 0,
    onUploadProgress: (progress) => {
      if (progress.total) {
        onUploadProgress?.(Math.round((progress.loaded / progress.total) * 100));
      }
    },
  });
  return response.data;
}

/** Launches processing for an idle batch job assembled via createBatchJob. */
export async function startJob(jobId: string): Promise<ProcessingJob> {
  const response = await api.post<ProcessingJob>(
    `/jobs/${encodeURIComponent(jobId)}/start/`
  );
  return response.data;
}

export async function getJob(jobId: string): Promise<ProcessingJob> {
  const response = await api.get<ProcessingJob>(
    `/jobs/${encodeURIComponent(jobId)}/`
  );
  return response.data;
}

export async function deleteJob(jobId: string): Promise<void> {
  await api.delete(`/jobs/${encodeURIComponent(jobId)}/`);
}

export async function updateDocumentField(
  documentId: string,
  fieldId: string,
  value: string
): Promise<PDFDocumentRecord> {
  const response = await api.patch<PDFDocumentRecord>(
    `/documents/${encodeURIComponent(documentId)}/`,
    { fieldId, value }
  );
  return response.data;
}

export async function updateDocumentReview(
  documentId: string,
  reviewed: boolean
): Promise<PDFDocumentRecord> {
  const response = await api.patch<PDFDocumentRecord>(
    `/documents/${encodeURIComponent(documentId)}/`,
    { reviewed }
  );
  return response.data;
}

export async function getDocumentFile(document: PDFDocumentRecord): Promise<ArrayBuffer> {
  const response = await api.get<ArrayBuffer>(
    document.fileUrl || `/documents/${encodeURIComponent(document.id)}/file/`,
    { responseType: 'arraybuffer' }
  );
  return response.data;
}

export async function downloadJobExport(
  jobId: string,
  type: 'primary' | 'diagnostics',
  options: {
    delimiter: 'comma' | 'semicolon' | 'tab';
    includeBom: boolean;
    useCorrectedValues: boolean;
    onlyReviewed: boolean;
    selectedFieldIds: string[];
  }
): Promise<Blob> {
  const response = await api.get<Blob>(
    `/jobs/${encodeURIComponent(jobId)}/export/`,
    {
      params: {
        type,
        delimiter: options.delimiter,
        includeBom: options.includeBom,
        useCorrectedValues: options.useCorrectedValues,
        onlyReviewed: options.onlyReviewed,
        fields: options.selectedFieldIds.join(','),
      },
      responseType: 'blob',
    }
  );
  return response.data;
}

export function getApiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<unknown>;
    const data = axiosError.response?.data;
    if (typeof data === 'string') {
      return data;
    }
    if (data && typeof data === 'object') {
      const detail = 'detail' in data ? data.detail : undefined;
      if (typeof detail === 'string') {
        return detail;
      }
      const firstValue = Object.values(data).flat(2).find(
        (value): value is string => typeof value === 'string'
      );
      if (firstValue) {
        return firstValue;
      }
    }
    return axiosError.message || 'The API request failed.';
  }
  return error instanceof Error ? error.message : String(error);
}
