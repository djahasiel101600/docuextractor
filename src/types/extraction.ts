/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type ExtractionStatus =
  | 'MATCHED'
  | 'FILENAME_ONLY'
  | 'NOT_FOUND'
  | 'MISMATCH'
  | 'INVALID'
  | 'AMBIGUOUS'
  | 'REVIEW_REQUIRED'
  | 'OCR_EXTRACTED'
  | 'AI_EXTRACTED'
  | 'MANUALLY_CORRECTED'
  | 'EXTRACTION_ERROR';

export type ExtractionSource = 'filename' | 'form_field' | 'pdf_text' | 'ocr' | 'ai' | 'manual';
export type ExtractionMethod = 'regex_filename' | 'label_proximity' | 'regex_content' | 'layout_aware' | 'acroform_name' | 'acroform_field' | 'acroform_pattern' | 'ocr_tesseract' | 'ollama_llm' | 'manual_override';

export type SourcePriority = 'pdf_first' | 'filename_first' | 'strict_match' | 'consensus';

export interface FieldDefinition {
  id: string;
  name: string;
  label: string;
  description?: string;
  type: 'text' | 'date' | 'number' | 'status' | 'email' | 'phone' | 'address';
  required: boolean;

  // Filename extraction rules
  filenameRules: {
    enabled: boolean;
    patterns: string[]; // Regex patterns
    captureGroup: number;
    caseInsensitive: boolean;
  };

  // PDF content extraction rules
  contentRules: {
    enabled: boolean;
    labels: string[]; // Primary and alias labels (e.g. "FULL NAME:", "Applicant Name:")
    regexPatterns?: string[]; // Regex search within PDF text
    positionHint?: 'after_label' | 'below_label' | 'table_cell' | 'any';
  };

  // Reconciliation & Normalization
  priority: SourcePriority;
  normalization: {
    trim: boolean;
    caseTransform: 'none' | 'uppercase' | 'lowercase' | 'titlecase';
    removeExtraSpaces: boolean;
    dateFormat?: 'YYYY-MM-DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'MM-DD-YYYY' | 'as_is';
  };

  // Validation rules
  validation: {
    formatRegex?: string;
    allowedValues?: string[]; // For status/enum
    minLength?: number;
    maxLength?: number;
  };
}

export interface ExtractionProfile {
  id: string;
  name: string;
  description: string;
  version: string;
  fields: FieldDefinition[];
  aiSettings?: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    timeoutSeconds: number;
    contextSize: number;
    strategy: 'review' | 'fallback' | 'selective';
    allowCloudModels?: boolean;
  };
  extractionSettings?: {
    labelSimilarityThreshold: number;
  };
  ocrSettings: {
    enabledFallback: boolean;
    autoDetectScanned: boolean;
    minTextLengthThreshold: number; // OCR pages with fewer native characters than this threshold
    language: string;
    quality?: 'standard' | 'high';
  };
  createdAt: string;
  updatedAt: string;
}

export interface FormWidgetLabelCandidate {
  text: string;
  placement: 'same_row' | 'above';
  distance: number;
}

export interface FormWidgetLayout {
  id: string;
  fieldName: string;
  fieldLabel: string;
  kind: string; // text | combo | list | checkbox | radio | button | signature | unknown
  pageNumber: number;
  rect: [number, number, number, number];
  prefilledValue: string | null;
  textMaxLength: number | null;
  options: string[]; // checkbox/radio export values
  labels: FormWidgetLabelCandidate[];
  suggestion: {
    fieldType?: string;
    name?: string;
    confidence: number;
    reason: string;
    validationRegex?: string;
    caseTransform?: string;
    minLength?: number;
  };
}

export interface BlankFormAnalysis {
  pageCount: number;
  pages: { pageNumber: number; width: number; height: number }[];
  widgets: FormWidgetLayout[];
  widgetCount: number;
  prefilledCount: number;
  isBlank: boolean;
  warnings: string[];
}

export interface FieldDiagnostic {
  fieldId: string;
  fieldName: string;
  status: ExtractionStatus;
  filenameValue?: string;
  pdfValue?: string;
  ocrValue?: string;
  formValue?: string | null;
  aiValue?: string | null;
  aiEvidence?: string | null;
  aiSourceKind?: string | null;
  manualValue?: string;
  finalValue: string;
  source: ExtractionSource;
  method: ExtractionMethod;
  matchedPatternOrLabel?: string;
  validationPassed: boolean;
  validationError?: string;
  confidenceScore?: number; // Evidence score from 0 to 1; not a calibrated probability
  supportingEvidence?: string; // Text snippet around the match
  pageNumber?: number;
  pdfConfidenceScore?: number | null;
  ocrConfidenceScore?: number | null;
  formConfidenceScore?: number | null;
  formMethod?: string | null;
  pdfEvidence?: string | null;
  pdfPageNumber?: number | null;
  ocrEvidence?: string | null;
  ocrPageNumber?: number | null;
  formEvidence?: string | null;
  formPageNumber?: number | null;
  aiPageNumber?: number | null;
  candidateScores?: Partial<Record<'form_field' | 'pdf_text' | 'ocr', number>>;
  selectionReason?: string;
  explanation: string;
  isConflict: boolean;
  reviewRequired: boolean;
  isManuallyCorrected: boolean;
}

export interface PDFDocumentRecord {
  id: string;
  jobId: string;
  filename: string;
  relativePath: string;
  fileSizeBytes: number;
  pageCount: number;
  fileHash?: string;
  processingDurationMs?: number | null;
  processingMetrics?: Record<string, number | number[]>;

  // Status
  processingStatus: 'pending' | 'processing' | 'completed' | 'failed';
  errorDetails?: string;
  isEncryptedOrCorrupted?: boolean;
  extractionMethodUsed: 'NATIVE_PDF_TEXT' | 'OCR_EXTRACTED' | 'AI_EXTRACTED' | 'FAILED';

  // Extracted raw data
  rawFilenameText: string;
  rawExtractedPdfText: string;
  pdfTextLength: number;

  // Field results
  diagnostics: Record<string, FieldDiagnostic>;
  finalValues: Record<string, string>;

  // Review status
  isReviewed: boolean;
  reviewedAt?: string;
  reviewedBy?: string;

  // Audit trail of manual corrections
  editHistory: Array<{
    fieldId: string;
    previousValue: string;
    newValue: string;
    timestamp: string;
    note?: string;
  }>;

  // Blob or ArrayBuffer for in-browser rendering
  fileData?: ArrayBuffer;
  fileUrl?: string;
}

export interface ProcessingJob {
  id: string;
  name: string;
  createdAt: string;
  zipFilename: string;
  zipSizeBytes: number;
  profileId: string;
  profileName: string;

  // Metrics
  totalDiscovered: number;
  processedCount: number;
  failedCount: number;
  reviewRequiredCount: number;
  conflictCount: number;
  missingCount: number;
  invalidCount: number;

  status: 'idle' | 'running' | 'completed' | 'cancelled' | 'error';
  currentProcessingFile?: string;

  documents: PDFDocumentRecord[];
}

export interface ProcessingJobProgress {
  id: string;
  status: ProcessingJob['status'];
  totalDiscovered: number;
  processedCount: number;
  failedCount: number;
  currentProcessingFile: string;
  currentProcessingFiles: string[];
  remainingCount: number;
  elapsedSeconds: number;
  averageSecondsPerDocument: number | null;
  estimatedRemainingSeconds: number | null;
  workerCount: number;
}
