/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ExtractionProfile, PDFDocumentRecord } from '../types/extraction';

export type CsvDelimiter = ',' | ';' | '\t';

export interface CsvExportOptions {
  delimiter: CsvDelimiter;
  includeBom: boolean; // UTF-8 BOM for Microsoft Excel
  useCorrectedValues: boolean; // if false, use initial extracted value
  selectedFieldIds?: string[];
  onlyReviewed?: boolean;
  // Off by default: a primary export must not ship values that failed
  // validation as if they were extracted data.
  includeInvalid?: boolean;
  // Every profile in the workspace. A batch can mix profiles, so each document
  // resolves the profile it was actually extracted with from this list.
  profiles?: ExtractionProfile[];
}

export interface ExportFieldDefinition {
  id: string;
  name: string;
}

/**
 * Resolves the Extraction Profile a document was processed with. The document's
 * own assignment wins; the job-level profile is only the fallback the backend
 * pipeline itself uses.
 */
export function resolveDocumentProfile(
  document: PDFDocumentRecord,
  profiles: ExtractionProfile[],
  jobProfile?: ExtractionProfile
): ExtractionProfile | undefined {
  if (document.profileId) {
    const assigned = profiles.find((profile) => profile.id === document.profileId);
    if (assigned) return assigned;
  }
  return jobProfile;
}

/**
 * Union of the field definitions across the job-level profile and every profile
 * actually used by the exported documents, in stable order. Mirrors the backend
 * export so the preview and the downloaded file share the same columns.
 */
export function collectExportFields(
  documents: PDFDocumentRecord[],
  profiles: ExtractionProfile[],
  jobProfile?: ExtractionProfile,
  selectedFieldIds?: string[]
): ExportFieldDefinition[] {
  const ordered: ExportFieldDefinition[] = [];
  const seen = new Set<string>();
  const pushProfile = (target?: ExtractionProfile) => {
    target?.fields.forEach((field) => {
      if (seen.has(field.id)) return;
      if (selectedFieldIds && !selectedFieldIds.includes(field.id)) return;
      seen.add(field.id);
      ordered.push({ id: field.id, name: field.name });
    });
  };
  pushProfile(jobProfile);
  documents.forEach((document) =>
    pushProfile(resolveDocumentProfile(document, profiles, jobProfile))
  );
  return ordered;
}

/**
 * Display name of the profile a document was processed with.
 */
function documentProfileName(
  document: PDFDocumentRecord,
  profiles: ExtractionProfile[],
  jobProfile?: ExtractionProfile
): string {
  return (
    document.profileName ||
    resolveDocumentProfile(document, profiles, jobProfile)?.name ||
    ''
  );
}

/**
 * Escapes a single CSV cell according to RFC 4180
 */
export function escapeCsvCell(value: string | number | undefined | null, delimiter: CsvDelimiter): string {
  if (value === undefined || value === null) return '';
  const str = String(value);

  // If contains delimiter, double quote, or newlines, enclose in quotes and escape internal quotes
  const needsQuotes =
    str.includes(delimiter) || str.includes('"') || str.includes('\n') || str.includes('\r');

  if (needsQuotes) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generates the Primary CSV containing final extracted and reconciled dataset
 */
export function generatePrimaryCsv(
  documents: PDFDocumentRecord[],
  profile: ExtractionProfile,
  options: CsvExportOptions = { delimiter: ',', includeBom: true, useCorrectedValues: true }
): string {
  const {
    delimiter,
    includeBom,
    useCorrectedValues,
    selectedFieldIds,
    includeInvalid = false,
    profiles = [],
  } = options;

  // Columns cover every profile used by the exported documents, so a mixed
  // batch never silently drops fields that only another profile defines.
  const activeFields = collectExportFields(documents, profiles, profile, selectedFieldIds);

  // Headers (order matches the backend export)
  const headers = [
    'Document Filename',
    'Relative Directory Path',
    'Extraction Profile',
    'Processing Status',
    'Extraction Method Used',
    'Review Status',
    'Flagged Values',
    ...activeFields.map((f) => f.name),
  ];

  const rows: string[] = [headers.map((h) => escapeCsvCell(h, delimiter)).join(delimiter)];

  for (const doc of documents) {
    // INVALID values are diagnostic, not data: blank them unless the caller
    // explicitly opts in, and always summarize them in Flagged Values.
    const flagged = activeFields
      .filter((field) => doc.diagnostics[field.id]?.status === 'INVALID')
      .map((field) => {
        const diag = doc.diagnostics[field.id];
        return `${field.name}: ${diag.validationError || 'INVALID'}`;
      })
      .join(' | ');

    const rowValues: string[] = [
      escapeCsvCell(doc.filename, delimiter),
      escapeCsvCell(doc.relativePath, delimiter),
      escapeCsvCell(documentProfileName(doc, profiles, profile), delimiter),
      escapeCsvCell(doc.processingStatus, delimiter),
      escapeCsvCell(doc.extractionMethodUsed, delimiter),
      escapeCsvCell(doc.isReviewed ? 'Reviewed' : 'Pending Review', delimiter),
      escapeCsvCell(flagged, delimiter),
    ];

    for (const field of activeFields) {
      const diag = doc.diagnostics[field.id];
      if (!includeInvalid && diag?.status === 'INVALID') {
        rowValues.push('');
        continue;
      }
      let val = '';
      if (diag) {
        if (!useCorrectedValues && diag.isManuallyCorrected) {
          // Use original extracted value before user correction
          val = diag.pdfValue || diag.filenameValue || diag.ocrValue || '';
        } else {
          val = doc.finalValues[field.id] || diag.finalValue || '';
        }
      }
      rowValues.push(escapeCsvCell(val, delimiter));
    }

    rows.push(rowValues.join(delimiter));
  }

  const csvString = rows.join('\r\n');
  return includeBom ? '\uFEFF' + csvString : csvString;
}

/**
 * Generates the detailed Diagnostics CSV with one row per field extraction event
 */
export function generateDiagnosticsCsv(
  documents: PDFDocumentRecord[],
  profile: ExtractionProfile,
  options: CsvExportOptions = { delimiter: ',', includeBom: true, useCorrectedValues: true }
): string {
  const { delimiter, includeBom, selectedFieldIds, profiles = [] } = options;

  // Same union of fields as the primary report: a document extracted with a
  // different profile still contributes its own field diagnostics.
  const activeFields = collectExportFields(documents, profiles, profile, selectedFieldIds);

  const headers = [
    'Document Filename',
    'Relative Path',
    'Extraction Profile',
    'Field ID',
    'Field Name',
    'Match Status',
    'Final Value',
    'Filename Extracted Value',
    'PDF Extracted Value',
    'Form Field Extracted Value',
    'OCR Extracted Value',
    'Extraction Source',
    'Extraction Method',
    'Matched Pattern or Label',
    'Validation Passed',
    'Validation Error',
    'Confidence Score',
    'Page Number',
    'Manual Review Required',
    'Is Manually Corrected',
    'Diagnostic Explanation',
    'Supporting Text Evidence',
    'PDF Candidate Evidence Score',
    'OCR Candidate Evidence Score',
    'Candidate Selection Reason',
    'PDF Candidate Evidence',
    'OCR Candidate Evidence',
    'PDF Candidate Page',
    'OCR Candidate Page',
  ];

  const rows: string[] = [headers.map((h) => escapeCsvCell(h, delimiter)).join(delimiter)];

  for (const doc of documents) {
    for (const field of activeFields) {
      const diag = doc.diagnostics[field.id];
      if (!diag) continue;

      const rowValues = [
        escapeCsvCell(doc.filename, delimiter),
        escapeCsvCell(doc.relativePath, delimiter),
        escapeCsvCell(documentProfileName(doc, profiles, profile), delimiter),
        escapeCsvCell(field.id, delimiter),
        escapeCsvCell(field.name, delimiter),
        escapeCsvCell(diag.status, delimiter),
        escapeCsvCell(doc.finalValues[field.id] || diag.finalValue, delimiter),
        escapeCsvCell(diag.filenameValue || '', delimiter),
        escapeCsvCell(diag.pdfValue || '', delimiter),
        escapeCsvCell(diag.formValue || '', delimiter),
        escapeCsvCell(diag.ocrValue || '', delimiter),
        escapeCsvCell(diag.source, delimiter),
        escapeCsvCell(diag.method, delimiter),
        escapeCsvCell(diag.matchedPatternOrLabel || '', delimiter),
        escapeCsvCell(diag.validationPassed ? 'PASSED' : 'FAILED', delimiter),
        escapeCsvCell(diag.validationError || '', delimiter),
        escapeCsvCell(diag.confidenceScore !== undefined ? `${Math.round(diag.confidenceScore * 100)}%` : 'N/A', delimiter),
        escapeCsvCell(diag.pageNumber || '', delimiter),
        escapeCsvCell(diag.reviewRequired ? 'YES' : 'NO', delimiter),
        escapeCsvCell(diag.isManuallyCorrected ? 'YES' : 'NO', delimiter),
        escapeCsvCell(diag.explanation, delimiter),
        escapeCsvCell(diag.supportingEvidence || '', delimiter),
        escapeCsvCell(diag.candidateScores?.pdf_text !== undefined ? `${Math.round(diag.candidateScores.pdf_text * 100)}%` : '', delimiter),
        escapeCsvCell(diag.candidateScores?.ocr !== undefined ? `${Math.round(diag.candidateScores.ocr * 100)}%` : '', delimiter),
        escapeCsvCell(diag.selectionReason || '', delimiter),
        escapeCsvCell(diag.pdfEvidence || '', delimiter),
        escapeCsvCell(diag.ocrEvidence || '', delimiter),
        escapeCsvCell(diag.pdfPageNumber || '', delimiter),
        escapeCsvCell(diag.ocrPageNumber || '', delimiter),
      ];

      rows.push(rowValues.join(delimiter));
    }
  }

  const csvString = rows.join('\r\n');
  return includeBom ? '\uFEFF' + csvString : csvString;
}

/**
 * Triggers a client-side browser download for a CSV string
 */
export function downloadCsvFile(csvContent: string, filename: string): void {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
