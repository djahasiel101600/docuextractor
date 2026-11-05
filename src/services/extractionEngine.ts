/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ExtractionProfile,
  FieldDefinition,
  FieldDiagnostic,
  ExtractionStatus,
  ExtractionSource,
  ExtractionMethod,
} from '../types/extraction';
import { PDFDocumentExtractionResult } from './pdfService';

/**
 * Normalizes an extracted raw string according to field configuration
 */
export function normalizeValue(
  value: string | undefined | null,
  normalization: FieldDefinition['normalization']
): string {
  if (!value) return '';

  let normalized = value;

  if (normalization.removeExtraSpaces) {
    normalized = normalized.replace(/\s+/g, ' ');
  }

  if (normalization.trim) {
    normalized = normalized.trim();
  }

  // Remove trailing colons, semicolons, or dashes that might have come from label boundaries
  normalized = normalized.replace(/^[:\-–—\s]+|[:\-–—\s]+$/g, '').trim();

  // Date normalization if requested
  if (normalization.dateFormat && normalization.dateFormat !== 'as_is') {
    normalized = standardizeDateFormat(normalized, normalization.dateFormat);
  }

  // Case transform
  if (normalization.caseTransform === 'uppercase') {
    normalized = normalized.toUpperCase();
  } else if (normalization.caseTransform === 'lowercase') {
    normalized = normalized.toLowerCase();
  } else if (normalization.caseTransform === 'titlecase') {
    normalized = toTitleCase(normalized);
  }

  return normalized;
}

function toTitleCase(str: string): string {
  return str.replace(/\w\S*/g, (txt) => {
    return txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase();
  });
}

function standardizeDateFormat(val: string, targetFormat: 'YYYY-MM-DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'MM-DD-YYYY'): string {
  // Try matching standard patterns like YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY, or Month DD, YYYY
  const isoMatch = val.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (isoMatch) {
    const y = isoMatch[1];
    const m = isoMatch[2].padStart(2, '0');
    const d = isoMatch[3].padStart(2, '0');
    if (targetFormat === 'YYYY-MM-DD') return `${y}-${m}-${d}`;
    if (targetFormat === 'DD/MM/YYYY') return `${d}/${m}/${y}`;
    if (targetFormat === 'MM/DD/YYYY') return `${m}/${d}/${y}`;
    if (targetFormat === 'MM-DD-YYYY') return `${m}-${d}-${y}`;
  }

  const slashMatch = val.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (slashMatch) {
    const first = slashMatch[1].padStart(2, '0');
    const second = slashMatch[2].padStart(2, '0');
    const y = slashMatch[3];
    // Slash-separated dates default to month-first unless the requested output is day-first.
    if (targetFormat === 'YYYY-MM-DD') return `${y}-${first}-${second}`;
    if (targetFormat === 'DD/MM/YYYY') return `${second}/${first}/${y}`;
    if (targetFormat === 'MM/DD/YYYY') return `${first}/${second}/${y}`;
    if (targetFormat === 'MM-DD-YYYY') return `${first}-${second}-${y}`;
  }

  return val;
}

/**
 * Extracts a field value from the filename using configured regex patterns
 */
export function extractFromFilename(
  filename: string,
  field: FieldDefinition
): {
  value?: string;
  matchedPattern?: string;
  matchedGroup?: string;
} {
  if (!field.filenameRules.enabled || !field.filenameRules.patterns?.length) {
    return {};
  }

  // Strip extension for cleaner matching, but keep original filename as fallback
  const basename = filename.replace(/\.[^/.]+$/, '');

  for (const patternStr of field.filenameRules.patterns) {
    if (!patternStr.trim()) continue;
    try {
      const flags = field.filenameRules.caseInsensitive ? 'i' : '';
      const regex = new RegExp(patternStr, flags);
      const match = basename.match(regex) || filename.match(regex);

      if (match) {
        const groupIdx = field.filenameRules.captureGroup || 1;
        const captured = match[groupIdx] !== undefined ? match[groupIdx] : match[0];
        if (captured && captured.trim()) {
          return {
            value: captured.trim(),
            matchedPattern: patternStr,
            matchedGroup: `Group #${groupIdx}`,
          };
        }
      }
    } catch (e) {
      console.warn(`Invalid regex in field ${field.id}:`, patternStr, e);
    }
  }

  return {};
}

/**
 * Extracts a field value from PDF text lines and items
 */
export function extractFromPdfContent(
  pdfData: PDFDocumentExtractionResult,
  field: FieldDefinition
): {
  value?: string;
  matchedLabelOrRegex?: string;
  method: ExtractionMethod;
  supportingEvidence?: string;
  pageNumber?: number;
} {
  if (!field.contentRules.enabled) {
    return { method: 'label_proximity' };
  }

  const { labels = [], regexPatterns = [] } = field.contentRules;

  // 1. Try Label-Based Extraction
  for (const label of labels) {
    if (!label.trim()) continue;
    const cleanLabel = label.trim().toLowerCase();

    for (const page of pdfData.pages) {
      for (let i = 0; i < page.lines.length; i++) {
        const line = page.lines[i];
        const lowerLine = line.toLowerCase();
        const labelIdx = lowerLine.indexOf(cleanLabel);

        if (labelIdx !== -1) {
          // Label found on this line!
          // Check if value is on the same line after the label
          const afterLabel = line.substring(labelIdx + label.length).trim();
          let candidate = afterLabel;

          // If empty and next line exists, check if next line is the value (stacked layout)
          if (!candidate && i + 1 < page.lines.length) {
            const nextLine = page.lines[i + 1].trim();
            // Ensure next line is not another label
            const isNextLineAnotherLabel = labels.some((other) =>
              nextLine.toLowerCase().startsWith(other.toLowerCase())
            ) || nextLine.includes(':');

            if (!isNextLineAnotherLabel) {
              candidate = nextLine;
            }
          }

          // Strip common punctuation like leading colons or trailing separators
          candidate = candidate.replace(/^[:\-–—\s]+/, '').trim();

          // Stop if candidate contains another known label
          for (const otherLabel of labels) {
            if (otherLabel.toLowerCase() !== cleanLabel) {
              const otherIdx = candidate.toLowerCase().indexOf(otherLabel.toLowerCase());
              if (otherIdx > 0) {
                candidate = candidate.substring(0, otherIdx).trim();
              }
            }
          }

          if (candidate) {
            // Build supporting evidence snippet (previous line, current, next)
            const snippetStart = Math.max(0, i - 1);
            const snippetEnd = Math.min(page.lines.length - 1, i + 1);
            const evidence = page.lines.slice(snippetStart, snippetEnd + 1).join('\n');

            return {
              value: candidate,
              matchedLabelOrRegex: label,
              method: 'label_proximity',
              supportingEvidence: evidence,
              pageNumber: page.pageNumber,
            };
          }
        }
      }
    }
  }

  // 2. Try Regex-Based Content Extraction
  for (const patternStr of regexPatterns) {
    if (!patternStr.trim()) continue;
    try {
      const regex = new RegExp(patternStr, 'i');

      for (const page of pdfData.pages) {
        const match = page.rawText.match(regex);
        if (match) {
          const val = match[1] || match[0];
          if (val && val.trim()) {
            const matchIndex = page.rawText.indexOf(match[0]);
            const startPos = Math.max(0, matchIndex - 60);
            const endPos = Math.min(page.rawText.length, matchIndex + match[0].length + 60);
            const evidence = page.rawText.substring(startPos, endPos).trim();

            return {
              value: val.trim(),
              matchedLabelOrRegex: patternStr,
              method: 'regex_content',
              supportingEvidence: evidence,
              pageNumber: page.pageNumber,
            };
          }
        }
      }
    } catch (e) {
      console.warn(`Invalid content regex for field ${field.id}:`, patternStr, e);
    }
  }

  return { method: 'label_proximity' };
}

/**
 * Validates a normalized value against field validation criteria
 */
export function validateFieldValue(
  val: string,
  field: FieldDefinition
): { valid: boolean; error?: string } {
  if (!val) {
    if (field.required) {
      return { valid: false, error: 'Required field is missing' };
    }
    return { valid: true };
  }

  // Allowed values (Enum check)
  if (field.validation.allowedValues && field.validation.allowedValues.length > 0) {
    const isAllowed = field.validation.allowedValues.some(
      (opt) => opt.toUpperCase() === val.toUpperCase()
    );
    if (!isAllowed) {
      return {
        valid: false,
        error: `Value "${val}" is not in allowed list: [${field.validation.allowedValues.join(', ')}]`,
      };
    }
  }

  // Format Regex check
  if (field.validation.formatRegex) {
    try {
      const reg = new RegExp(field.validation.formatRegex);
      if (!reg.test(val)) {
        return {
          valid: false,
          error: `Format does not match required pattern (${field.validation.formatRegex})`,
        };
      }
    } catch {
      // Ignore bad regex definition
    }
  }

  // Length checks
  if (field.validation.minLength && val.length < field.validation.minLength) {
    return {
      valid: false,
      error: `Length ${val.length} is less than minimum allowed (${field.validation.minLength})`,
    };
  }

  if (field.validation.maxLength && val.length > field.validation.maxLength) {
    return {
      valid: false,
      error: `Length ${val.length} exceeds maximum allowed (${field.validation.maxLength})`,
    };
  }

  // Email check
  if (field.type === 'email') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(val)) {
      return { valid: false, error: 'Invalid email address structure' };
    }
  }

  return { valid: true };
}

/**
 * Reconciles filename extraction with PDF content extraction, applies source priority,
 * detects conflicts, performs validation, and produces a complete field diagnostic.
 */
export function reconcileFieldExtraction(
  field: FieldDefinition,
  filenameValRaw?: string,
  pdfValRaw?: string,
  ocrValRaw?: string,
  matchedPatternOrLabel?: string,
  extractionMethod: ExtractionMethod = 'label_proximity',
  supportingEvidence?: string,
  pageNumber?: number,
  ocrConfidence?: number
): FieldDiagnostic {
  const normFilename = normalizeValue(filenameValRaw, field.normalization);
  const normPdf = normalizeValue(pdfValRaw, field.normalization);
  const normOcr = normalizeValue(ocrValRaw, field.normalization);

  const hasFilename = Boolean(normFilename);
  const hasPdf = Boolean(normPdf);
  const hasOcr = Boolean(normOcr);

  let finalValue = '';
  let source: ExtractionSource = 'pdf_text';
  let method: ExtractionMethod = extractionMethod;
  let status: ExtractionStatus = 'NOT_FOUND';
  let explanation = '';
  let isConflict = false;
  let reviewRequired = false;

  // Determine Primary Candidate & Conflicts
  if (hasFilename && hasPdf) {
    // Both exist: check if they agree
    if (normFilename.toUpperCase() === normPdf.toUpperCase()) {
      finalValue = normPdf;
      source = 'pdf_text';
      status = 'MATCHED';
      explanation = `Reconciled: Identical values extracted from both filename and PDF content ("${finalValue}").`;
    } else {
      // Conflict detected!
      isConflict = true;
      reviewRequired = true;
      status = 'MISMATCH';

      if (field.priority === 'filename_first') {
        finalValue = normFilename;
        source = 'filename';
        method = 'regex_filename';
        explanation = `Conflict flagged: Filename ("${normFilename}") differs from PDF ("${normPdf}"). Defaulted to Filename per priority rule; manual verification recommended.`;
      } else if (field.priority === 'pdf_first') {
        finalValue = normPdf;
        source = 'pdf_text';
        explanation = `Conflict flagged: PDF ("${normPdf}") differs from Filename ("${normFilename}"). Defaulted to PDF content per priority rule; manual verification recommended.`;
      } else {
        // Strict match: neither is automatically privileged
        finalValue = normPdf;
        source = 'pdf_text';
        explanation = `Conflict detected: Filename extracted "${normFilename}" while PDF extracted "${normPdf}". Flagged for mandatory review under Strict Match policy.`;
      }
    }
  } else if (hasPdf) {
    finalValue = normPdf;
    source = 'pdf_text';
    status = 'MATCHED';
    explanation = `Extracted from PDF content via ${method.replace('_', ' ')}.`;
  } else if (hasFilename) {
    finalValue = normFilename;
    source = 'filename';
    method = 'regex_filename';
    // Filename-only matches carry no document-side corroboration; give them
    // their own status so they never look like a form-verified MATCHED value.
    status = 'FILENAME_ONLY';
    explanation = `Extracted from filename via regex rule only; no document-side candidate existed to cross-check it.`;
  } else if (hasOcr) {
    finalValue = normOcr;
    source = 'ocr';
    method = 'ocr_tesseract';
    status = 'OCR_EXTRACTED';
    reviewRequired = true; // OCR results should be verified
    explanation = `Extracted via OCR fallback from scanned/rasterized document. Real OCR confidence: ${ocrConfidence !== undefined ? `${ocrConfidence}%` : 'Standard'
      }.`;
  } else {
    // Value not found anywhere
    status = 'NOT_FOUND';
    finalValue = '';
    explanation = field.required
      ? `Missing required field: Not found in filename or PDF document.`
      : `Optional field: Not present in document.`;
    if (field.required) {
      reviewRequired = true;
    }
  }

  // Run Validation on the chosen final value
  const validationResult = validateFieldValue(finalValue, field);
  const validationPassed = validationResult.valid;
  const validationError = validationResult.error;

  if (!validationPassed && status !== 'NOT_FOUND') {
    status = 'INVALID';
    reviewRequired = true;
    explanation = `Validation Failed: ${validationError}. (Extracted: "${finalValue}")`;
  }

  // Set confidence score ONLY if genuine (e.g. OCR confidence or regex exact match)
  let confidenceScore: number | undefined = undefined;
  if (source === 'ocr' && ocrConfidence !== undefined) {
    confidenceScore = ocrConfidence;
  } else if (status === 'MATCHED' && hasFilename && hasPdf && normFilename === normPdf) {
    confidenceScore = 99; // Consensus match
  }

  return {
    fieldId: field.id,
    fieldName: field.name,
    status,
    filenameValue: normFilename || undefined,
    pdfValue: normPdf || undefined,
    ocrValue: normOcr || undefined,
    finalValue,
    source,
    method,
    matchedPatternOrLabel,
    validationPassed,
    validationError,
    confidenceScore,
    supportingEvidence,
    pageNumber,
    explanation,
    isConflict,
    reviewRequired,
    isManuallyCorrected: false,
  };
}

/**
 * Process a single PDF document through all configured fields of a profile
 */
export async function processDocumentRecord(
  filename: string,
  relativePath: string,
  fileBuffer: ArrayBuffer,
  profile: ExtractionProfile
): Promise<{
  diagnostics: Record<string, FieldDiagnostic>;
  finalValues: Record<string, string>;
  rawPdfText: string;
  pdfTextLength: number;
  pageCount: number;
  extractionMethodUsed: 'NATIVE_PDF_TEXT' | 'OCR_EXTRACTED' | 'FAILED';
  errorDetails?: string;
}> {
  try {
    const { extractNativePdfData, performOcrFallback } = await import('./pdfService');
    const pdfData = await extractNativePdfData(
      fileBuffer,
      profile.ocrSettings.minTextLengthThreshold
    );

    let ocrText = '';
    let ocrConfidence: number | undefined = undefined;
    let extractionMethodUsed: 'NATIVE_PDF_TEXT' | 'OCR_EXTRACTED' | 'FAILED' = 'NATIVE_PDF_TEXT';

    // If document is scanned or text is insufficient, invoke OCR fallback if enabled
    if (pdfData.isScannedOrInsufficientText && profile.ocrSettings.enabledFallback) {
      const ocrResult = await performOcrFallback(
        fileBuffer,
        2,
        profile.ocrSettings.language
      );
      ocrText = ocrResult.ocrText;
      ocrConfidence = ocrResult.confidence;
      if (ocrText.length > 10) {
        extractionMethodUsed = 'OCR_EXTRACTED';
      }
    }

    const diagnostics: Record<string, FieldDiagnostic> = {};
    const finalValues: Record<string, string> = {};

    for (const field of profile.fields) {
      // 1. Filename extraction
      const filenameResult = extractFromFilename(filename, field);

      // 2. PDF Content extraction
      const pdfContentResult = extractFromPdfContent(pdfData, field);

      // 3. OCR extraction if needed and available
      let ocrFieldValue: string | undefined = undefined;
      if (ocrText && !pdfContentResult.value) {
        // Try regex patterns or labels against OCR text
        for (const label of field.contentRules.labels || []) {
          const lIdx = ocrText.toLowerCase().indexOf(label.toLowerCase());
          if (lIdx !== -1) {
            const candidate = ocrText.substring(lIdx + label.length, lIdx + label.length + 80).split('\n')[0].trim();
            if (candidate) {
              ocrFieldValue = candidate.replace(/^[:\-–—\s]+/, '').trim();
              break;
            }
          }
        }
      }

      // 4. Reconcile
      const diag = reconcileFieldExtraction(
        field,
        filenameResult.value,
        pdfContentResult.value,
        ocrFieldValue,
        pdfContentResult.matchedLabelOrRegex || filenameResult.matchedPattern,
        ocrFieldValue ? 'ocr_tesseract' : pdfContentResult.method,
        pdfContentResult.supportingEvidence,
        pdfContentResult.pageNumber,
        ocrConfidence
      );

      diagnostics[field.id] = diag;
      finalValues[field.id] = diag.finalValue;
    }

    return {
      diagnostics,
      finalValues,
      rawPdfText: pdfData.fullText || ocrText,
      pdfTextLength: pdfData.totalCharacters || ocrText.length,
      pageCount: pdfData.pageCount,
      extractionMethodUsed,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Extraction failed on ${filename}:`, err);

    // Fallback: at least extract what we can from filename
    const diagnostics: Record<string, FieldDiagnostic> = {};
    const finalValues: Record<string, string> = {};

    for (const field of profile.fields) {
      const filenameResult = extractFromFilename(filename, field);
      const diag = reconcileFieldExtraction(
        field,
        filenameResult.value,
        undefined,
        undefined,
        filenameResult.matchedPattern,
        'regex_filename'
      );
      diag.explanation = `PDF Content unreadable (${errorMsg}). Value extracted from filename only.`;
      diagnostics[field.id] = diag;
      finalValues[field.id] = diag.finalValue;
    }

    return {
      diagnostics,
      finalValues,
      rawPdfText: '',
      pdfTextLength: 0,
      pageCount: 0,
      extractionMethodUsed: 'FAILED',
      errorDetails: errorMsg,
    };
  }
}
