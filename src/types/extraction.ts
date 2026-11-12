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
  | 'OCR_SPACE_EXTRACTED'
  | 'AI_EXTRACTED'
  | 'MANUALLY_CORRECTED'
  | 'EXTRACTION_ERROR';

export type ExtractionSource = 'filename' | 'form_field' | 'pdf_text' | 'ocr' | 'ocr_space' | 'ai' | 'manual';
export type ExtractionMethod = 'regex_filename' | 'label_proximity' | 'regex_content' | 'layout_aware' | 'acroform_name' | 'acroform_field' | 'acroform_pattern' | 'ocr_tesseract' | 'ollama_llm' | 'manual_override';

/**
 * Reconciliation policy. 'strict_match' is the canonical stored value;
 * 'strict' is accepted as an alias (the specification's name) and is
 * normalized by the backend before use. 'consensus' is an extension: every
 * available source must agree or the value is flagged.
 */
export type SourcePriority = 'pdf_first' | 'filename_first' | 'strict_match' | 'strict' | 'consensus';

export interface FieldDefinition {
  id: string;
  name: string;
  label: string;
  description?: string;
  type: 'text' | 'date' | 'number' | 'status' | 'email' | 'phone' | 'address' | 'checkbox';
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
    /**
     * How ambiguous numeric dates (both components <= 12) are read.
     * Defaults to 'month_first' (US forms). An explicit DD/MM/YYYY target
     * format implies 'day_first' and wins over this setting.
     */
    dateOrder?: 'month_first' | 'day_first';
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
    /**
     * When true, only page 1 is read: native text, AcroForm widgets, OCR and
     * the AI context all ignore later pages. For multi-page forms whose
     * answers live on page 1 (e.g. a W-9 followed by IRS instructions).
     */
    firstPageOnly?: boolean;
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
  /** Status before validation replaced it with INVALID (e.g. MISMATCH).
   *  Keeps source-disagreement visible when the value also fails validation. */
  statusBeforeValidation?: ExtractionStatus | null;
  filenameValue?: string;
  pdfValue?: string;
  ocrValue?: string;
  ocrSpaceValue?: string;
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
  ocrSpaceEvidence?: string | null;
  ocrSpacePageNumber?: number | null;
  ocrSpaceConfidenceScore?: number | null;
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
  // 'skipped_unassigned' means the file was never extracted because no
  // profile could be assigned to it - it is pending assignment, not a failure.
  processingStatus:
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'excluded'
  | 'skipped_unassigned';
  errorDetails?: string;
  isEncryptedOrCorrupted?: boolean;
  extractionMethodUsed: 'NATIVE_PDF_TEXT' | 'OCR_EXTRACTED' | 'AI_EXTRACTED' | 'FAILED';

  // Assignment Metadata
  profileId: string | null;
  profileName?: string | null;
  assignmentStatus: 'legacy' | 'assigned' | 'manual' | 'ambiguous' | 'unassigned' | 'excluded';
  assignmentMethod?: string;
  assignmentRule?: string;
  assignmentConfidence?: number;
  assignmentReason?: string;

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

export interface DocumentAssignment {
  id: string;
  filename: string;
  profileId: string | null;
  profileName: string | null;
  assignmentStatus: 'legacy' | 'assigned' | 'manual' | 'ambiguous' | 'unassigned' | 'excluded';
  /** How the current assignment was produced: "", "manual" or "bulk". */
  assignmentMethod: string;
  assignmentConfidence: number;
  assignmentReason: string;
  /** Pipeline state; bulk assignment only touches "pending" documents. */
  processingStatus: string;
}

export type BulkAssignmentFilterType = 'filename_pattern' | 'exact_match';

export interface BulkAssignmentRequest {
  /** null clears the assignment for every matched document. */
  profileId: string | null;
  filter: {
    type: BulkAssignmentFilterType;
    value: string;
  };
}

export interface BulkAssignmentResult {
  matched: number;
  updated: number;
  skipped_already_assigned: number;
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
  skippedCount: number;
  reviewRequiredCount: number;
  conflictCount: number;
  missingCount: number;
  invalidCount: number;

  status: 'idle' | 'running' | 'completed' | 'cancelled' | 'error';
  currentProcessingFile?: string;
  cancelRequested?: boolean;

  documents: PDFDocumentRecord[];
}

export interface ProcessingJobProgress {
  id: string;
  status: ProcessingJob['status'];
  totalDiscovered: number;
  processedCount: number;
  failedCount: number;
  skippedCount: number;
  currentProcessingFile: string;
  currentProcessingFiles: string[];
  remainingCount: number;
  elapsedSeconds: number;
  averageSecondsPerDocument: number | null;
  estimatedRemainingSeconds: number | null;
  workerCount: number;
  cancelRequested: boolean;
}
