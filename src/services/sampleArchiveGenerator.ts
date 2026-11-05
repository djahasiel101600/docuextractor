/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import JSZip from 'jszip';

function escapePdfText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Creates an authentic, professional, multi-section digital PDF form binary (PDF 1.4)
 * with visual table boxes, shaded headers, border grids, and official seals.
 */
export function generateSyntheticPdf(
  title: string,
  fields: Array<{ label: string; value: string }>,
  notes?: string
): Uint8Array {
  let stream = '';

  // 1. Crisp white background
  stream += '1 1 1 rg 0 0 612 792 re f\n';

  // 2. Outer decorative document frame
  stream += '0.2 0.25 0.3 RG 1.5 w 28 28 556 736 re S\n';
  stream += '0.7 0.75 0.8 RG 0.5 w 32 32 548 728 re S\n';

  // 3. Top Official Agency Banner (Dark Navy Banner)
  stream += '0.1 0.15 0.22 rg 36 700 540 52 re f\n';
  stream += 'BT /F1 8 Tf 0.8 0.85 0.95 rg 50 736 Td (REPUBLIC OF THE PHILIPPINES  |  OFFICIAL CIVIL REGISTRATION WORKSTATION) Tj ET\n';
  stream += `BT /F1 13 Tf 1 1 1 rg 50 714 Td (${escapePdfText(title)}) Tj ET\n`;

  // Right-side barcode representation
  stream += '0.3 0.35 0.45 rg 480 706 85 40 re f\n';
  stream += 'BT /F1 7 Tf 1 1 1 rg 488 722 Td (FORM 2026-A) Tj ET\n';
  stream += 'BT /F1 6 Tf 0.9 0.9 0.9 rg 488 712 Td (DIGITAL RECORD) Tj ET\n';

  // 4. Section 1: Identification & Account Particulars
  stream += '0.92 0.94 0.97 rg 36 672 540 18 re f\n';
  stream += '0.2 0.25 0.3 RG 1 w 36 530 540 160 re S\n';
  stream += 'BT /F1 9 Tf 0.1 0.15 0.25 rg 46 676 Td (SECTION I: APPLICANT IDENTIFICATION & STATUS) Tj ET\n';

  // Grid lines inside Section 1
  stream += '0.85 0.88 0.9 RG 0.75 w\n';
  stream += '36 625 m 576 625 l S\n';
  stream += '36 578 m 576 578 l S\n';

  // Search for fields matching section 1
  const refField = fields.find((f) => f.label.toLowerCase().includes('reference') || f.label.toLowerCase().includes('ref'));
  const nameField = fields.find((f) => f.label.toLowerCase().includes('name'));
  const statusField = fields.find((f) => f.label.toLowerCase().includes('status'));

  if (refField) {
    stream += 'BT /F1 8 Tf 0.4 0.45 0.5 rg 46 658 Td (REFERENCE NUMBER / TRANSACTION ID) Tj ET\n';
    stream += `BT /F1 11 Tf 0 0 0 rg 46 638 Td (${escapePdfText(refField.label)} ${escapePdfText(refField.value)}) Tj ET\n`;
  }

  if (nameField) {
    stream += 'BT /F1 8 Tf 0.4 0.45 0.5 rg 46 610 Td (FULL LEGAL NAME OF REGISTRANT) Tj ET\n';
    stream += `BT /F1 12 Tf 0.05 0.1 0.2 rg 46 590 Td (${escapePdfText(nameField.label)} ${escapePdfText(nameField.value)}) Tj ET\n`;
  }

  if (statusField) {
    const isInactive = statusField.value.toUpperCase().includes('INACTIVE');
    const isPending = statusField.value.toUpperCase().includes('PENDING');

    stream += 'BT /F1 8 Tf 0.4 0.45 0.5 rg 46 564 Td (REGISTRATION STATUS CLASSIFICATION) Tj ET\n';
    stream += `BT /F1 11 Tf 0 0 0 rg 46 544 Td (${escapePdfText(statusField.label)} ${escapePdfText(statusField.value)}) Tj ET\n`;

    // Visual Status Badge Stamp in PDF
    if (isInactive) {
      stream += '0.95 0.9 0.9 rg 430 538 135 24 re f\n';
      stream += '0.8 0.2 0.2 RG 1.5 w 430 538 135 24 re S\n';
      stream += 'BT /F1 9 Tf 0.7 0.1 0.1 rg 445 545 Td ([ INACTIVE STATUS ]) Tj ET\n';
    } else if (isPending) {
      stream += '0.98 0.95 0.88 rg 430 538 135 24 re f\n';
      stream += '0.85 0.55 0.1 RG 1.5 w 430 538 135 24 re S\n';
      stream += 'BT /F1 9 Tf 0.7 0.4 0.05 rg 445 545 Td ([ PENDING REVIEW ]) Tj ET\n';
    } else {
      stream += '0.9 0.96 0.92 rg 430 538 135 24 re f\n';
      stream += '0.1 0.6 0.3 RG 1.5 w 430 538 135 24 re S\n';
      stream += 'BT /F1 9 Tf 0.05 0.5 0.2 rg 448 545 Td ([ ACTIVE RECORD ]) Tj ET\n';
    }
  }

  // 5. Section 2: Residential Address & Local Administrative Jurisdiction
  stream += '0.92 0.94 0.97 rg 36 500 540 18 re f\n';
  stream += '0.2 0.25 0.3 RG 1 w 36 370 540 148 re S\n';
  stream += 'BT /F1 9 Tf 0.1 0.15 0.25 rg 46 504 Td (SECTION II: RESIDENTIAL ADDRESS & LOCAL JURISDICTION) Tj ET\n';

  const addressField = fields.find((f) => f.label.toLowerCase().includes('address'));
  const cityField = fields.find((f) => f.label.toLowerCase().includes('city') || f.label.toLowerCase().includes('municipality'));
  const brgyField = fields.find((f) => f.label.toLowerCase().includes('barangay') || f.label.toLowerCase().includes('brgy'));

  stream += '0.85 0.88 0.9 RG 0.75 w\n';
  stream += '36 455 m 576 455 l S\n';
  stream += '36 412 m 576 412 l S\n';

  if (addressField) {
    stream += 'BT /F1 8 Tf 0.4 0.45 0.5 rg 46 486 Td (PERMANENT RESIDENCE / STREET ADDRESS) Tj ET\n';
    stream += `BT /F1 10 Tf 0 0 0 rg 46 468 Td (${escapePdfText(addressField.label)} ${escapePdfText(addressField.value)}) Tj ET\n`;
  } else {
    stream += 'BT /F1 8 Tf 0.4 0.45 0.5 rg 46 486 Td (PERMANENT RESIDENCE / STREET ADDRESS) Tj ET\n';
    stream += 'BT /F1 9 Tf 0.6 0.2 0.2 rg 46 468 Td (COMPLETE ADDRESS: [NOT PROVIDED IN FORM]) Tj ET\n';
  }

  if (cityField) {
    stream += 'BT /F1 8 Tf 0.4 0.45 0.5 rg 46 442 Td (CITY / MUNICIPALITY) Tj ET\n';
    stream += `BT /F1 10 Tf 0 0 0 rg 46 424 Td (${escapePdfText(cityField.label)} ${escapePdfText(cityField.value)}) Tj ET\n`;
  }

  if (brgyField) {
    stream += 'BT /F1 8 Tf 0.4 0.45 0.5 rg 46 398 Td (BARANGAY / ADMINISTRATIVE SUB-DISTRICT) Tj ET\n';
    stream += `BT /F1 10 Tf 0 0 0 rg 46 382 Td (${escapePdfText(brgyField.label)} ${escapePdfText(brgyField.value)}) Tj ET\n`;
  }

  // 6. Section 3: Filing Particulars & Date Submitted
  stream += '0.92 0.94 0.97 rg 36 340 540 18 re f\n';
  stream += '0.2 0.25 0.3 RG 1 w 36 240 540 118 re S\n';
  stream += 'BT /F1 9 Tf 0.1 0.15 0.25 rg 46 344 Td (SECTION III: FILING PARTICULARS & REGISTRY TRANSCRIPT) Tj ET\n';

  const dateField = fields.find((f) => f.label.toLowerCase().includes('date'));
  if (dateField) {
    stream += 'BT /F1 8 Tf 0.4 0.45 0.5 rg 46 325 Td (FILING DATE / SUBMISSION STAMP) Tj ET\n';
    stream += `BT /F1 10 Tf 0 0 0 rg 46 308 Td (${escapePdfText(dateField.label)} ${escapePdfText(dateField.value)}) Tj ET\n`;
  }

  if (notes) {
    stream += '0.98 0.96 0.92 rg 46 250 520 45 re f\n';
    stream += '0.85 0.7 0.4 RG 0.5 w 46 250 520 45 re S\n';
    stream += 'BT /F1 7 Tf 0.6 0.4 0.1 rg 54 282 Td (OFFICIAL REGISTRY MEMORANDUM:) Tj ET\n';
    stream += `BT /F1 8 Tf 0.3 0.2 0.05 rg 54 266 Td (${escapePdfText(notes)}) Tj ET\n`;
  }

  // 7. Official Legal Certification & Sign-off Block
  stream += '0.97 0.97 0.97 rg 36 120 540 105 re f\n';
  stream += '0.7 0.75 0.8 RG 1 w 36 120 540 105 re S\n';
  stream += 'BT /F1 8 Tf 0.2 0.25 0.35 rg 46 206 Td (CERTIFICATION OF RECORD ACCURACY:) Tj ET\n';
  stream += 'BT /F1 7 Tf 0.4 0.4 0.45 rg 46 192 Td (I hereby attest under legal affirmation that all particulars recorded above have been verified.) Tj ET\n';
  stream += 'BT /F1 7 Tf 0.4 0.4 0.45 rg 46 182 Td (This digital document transcript conforms to official electronic record keeping standards.) Tj ET\n';

  // Signature line
  stream += '0.5 0.5 0.5 RG 1 w 380 145 170 0.5 re S\n';
  stream += 'BT /F1 7 Tf 0.3 0.3 0.3 rg 400 132 Td (AUTHORIZED REGISTRAR SIGNATURE) Tj ET\n';

  // Official Stamp Box
  stream += '0.2 0.5 0.8 RG 1.5 w 46 130 110 38 re S\n';
  stream += 'BT /F1 8 Tf 0.1 0.4 0.7 rg 55 152 Td (OFFICIALLY FILED) Tj ET\n';
  stream += 'BT /F1 6 Tf 0.2 0.45 0.75 rg 55 140 Td (DIGITAL ARCHIVE 2026) Tj ET\n';

  // 8. Footer Bar
  stream += '0.8 0.85 0.9 RG 0.5 w 36 60 540 0.5 re S\n';
  stream += 'BT /F1 7 Tf 0.5 0.5 0.55 rg 46 46 Td (Document ID: 2026-FORM-REG-V2  |  Form Page 1 of 1  |  Security Hash: 8F92-BC44-77AE) Tj ET\n';

  const streamBytes = new TextEncoder().encode(stream);
  const streamLength = streamBytes.length;

  const objects: string[] = [];
  objects[1] = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  objects[2] = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
  objects[3] = '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n';
  objects[4] = `4 0 obj\n<< /Length ${streamLength} >>\nstream\n${stream}\nendstream\nendobj\n`;
  objects[5] = '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';

  let pdfText = '%PDF-1.4\n';
  const offsets: number[] = [0];

  for (let i = 1; i <= 5; i++) {
    offsets[i] = new TextEncoder().encode(pdfText).length;
    pdfText += objects[i];
  }

  const startXref = new TextEncoder().encode(pdfText).length;
  pdfText += 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) {
    const offsetStr = String(offsets[i]).padStart(10, '0');
    pdfText += `${offsetStr} 00000 n \n`;
  }
  pdfText += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + startXref + '\n%%EOF';

  return new TextEncoder().encode(pdfText);
}

/**
 * Creates a synthetic scanned/image PDF with minimal or no native text stream
 * to test the OCR Fallback pathway
 */
export function generateScannedStylePdf(
  title: string,
  fields: Array<{ label: string; value: string }>
): Uint8Array {
  let stream = '';
  // Parchment slightly-tinted scanned paper background
  stream += '0.98 0.97 0.94 rg 0 0 612 792 re f\n';
  // Distressed outer border
  stream += '0.4 0.38 0.35 RG 2 w 30 30 552 732 re S\n';
  // Scanned title header
  stream += '0.2 0.2 0.2 rg 36 710 540 40 re f\n';
  stream += 'BT /F1 12 Tf 1 1 1 rg 46 726 Td (RASTERIZED CIVIL RECORD - LOW OCR QUALITY SCAN) Tj ET\n';
  
  // Minimal text
  stream += 'BT /F1 8 Tf 0.2 0.2 0.2 rg 50 680 Td (SCANNED FORM) Tj ET\n';

  const streamBytes = new TextEncoder().encode(stream);
  const objects: string[] = [];
  objects[1] = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  objects[2] = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
  objects[3] = '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n';
  objects[4] = `4 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n${stream}\nendstream\nendobj\n`;
  objects[5] = '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';

  let pdfText = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = new TextEncoder().encode(pdfText).length;
    pdfText += objects[i];
  }

  const startXref = new TextEncoder().encode(pdfText).length;
  pdfText += 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) {
    const offsetStr = String(offsets[i]).padStart(10, '0');
    pdfText += `${offsetStr} 00000 n \n`;
  }
  pdfText += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + startXref + '\n%%EOF';

  return new TextEncoder().encode(pdfText);
}

/**
 * Generates an 8-document realistic ZIP archive containing multiple test scenarios:
 * - Nested directories (active, pending, review_needed, scanned)
 * - Matching records
 * - Conflicting records (Filename ACTIVE vs PDF INACTIVE)
 * - Missing field records (No address)
 * - Invalid format records (Corrupted reference number format)
 * - Low-text scanned record for OCR fallback demonstration
 */
export async function createDemoZipArchive(): Promise<Blob> {
  const zip = new JSZip();

  // 1. Clean Match 1
  const pdf1 = generateSyntheticPdf('INDIVIDUAL APPLICATION FORM', [
    { label: 'Reference Number:', value: '2026-00125' },
    { label: 'FULL NAME:', value: 'JUAN DELA CRUZ' },
    { label: 'STATUS:', value: 'ACTIVE' },
    { label: 'COMPLETE ADDRESS:', value: '124 Rizal Avenue' },
    { label: 'CITY/MUNICIPALITY:', value: 'Cabadbaran City' },
    { label: 'BARANGAY:', value: 'Barangay Poblacion 2' },
    { label: 'DATE SUBMITTED:', value: '2026-03-14' },
  ]);
  zip.file('batch_2026_q1/active/2026-00125-JUAN-DELA-CRUZ-ACTIVE.pdf', pdf1);

  // 2. Clean Match 2
  const pdf2 = generateSyntheticPdf('INDIVIDUAL APPLICATION FORM', [
    { label: 'Reference Number:', value: '2026-00126' },
    { label: 'FULL NAME:', value: 'MARIA SANTOS' },
    { label: 'STATUS:', value: 'INACTIVE' },
    { label: 'COMPLETE ADDRESS:', value: '45 Magsaysay Boulevard' },
    { label: 'CITY/MUNICIPALITY:', value: 'Butuan City' },
    { label: 'BARANGAY:', value: 'Barangay Libertad' },
    { label: 'DATE SUBMITTED:', value: '2026-03-15' },
  ]);
  zip.file('batch_2026_q1/active/2026-00126-MARIA-SANTOS-INACTIVE.pdf', pdf2);

  // 3. CONFLICT TEST: Filename says ACTIVE, but PDF says INACTIVE!
  const pdf3 = generateSyntheticPdf('INDIVIDUAL APPLICATION FORM', [
    { label: 'Reference Number:', value: '2026-00127' },
    { label: 'FULL NAME:', value: 'PEDRO REYES' },
    { label: 'STATUS:', value: 'INACTIVE' }, // Conflict!
    { label: 'COMPLETE ADDRESS:', value: '78 Mabini Street' },
    { label: 'CITY/MUNICIPALITY:', value: 'Cabadbaran City' },
    { label: 'BARANGAY:', value: 'Barangay Baybay' },
    { label: 'DATE SUBMITTED:', value: '2026-03-16' },
  ], 'Status was marked inactive during validation interview');
  zip.file('batch_2026_q1/review_needed/2026-00127-PEDRO-REYES-ACTIVE.pdf', pdf3);

  // 4. MISSING FIELD TEST: Address and City not in document
  const pdf4 = generateSyntheticPdf('INDIVIDUAL APPLICATION FORM', [
    { label: 'Reference Number:', value: '2026-00128' },
    { label: 'FULL NAME:', value: 'ELENA GOMEZ' },
    { label: 'STATUS:', value: 'ACTIVE' },
    { label: 'DATE SUBMITTED:', value: '2026-03-17' },
  ], 'Applicant did not supply permanent residential address line');
  zip.file('batch_2026_q1/review_needed/2026-00128-ELENA-GOMEZ-ACTIVE.pdf', pdf4);

  // 5. INVALID FORMAT TEST: Reference number contains invalid special symbols
  const pdf5 = generateSyntheticPdf('INDIVIDUAL APPLICATION FORM', [
    { label: 'Reference Number:', value: '2026-##99-INVALID' },
    { label: 'FULL NAME:', value: 'ROBERTO TAN' },
    { label: 'STATUS:', value: 'PENDING' },
    { label: 'COMPLETE ADDRESS:', value: '12 Bonifacio Extension' },
    { label: 'CITY/MUNICIPALITY:', value: 'Surigao City' },
    { label: 'BARANGAY:', value: 'Barangay Washington' },
    { label: 'DATE SUBMITTED:', value: '2026-03-18' },
  ]);
  zip.file('batch_2026_q1/review_needed/2026-00129-ROBERTO-TAN-INVALID.pdf', pdf5);

  // 6. SCANNED / IMAGE TEST: Minimal native text stream to demonstrate OCR Fallback
  const pdf6 = generateScannedStylePdf('SCANNED REGISTRATION', [
    { label: 'Reference Number:', value: '2026-00130' },
    { label: 'FULL NAME:', value: 'CARMEN DIAZ' },
  ]);
  zip.file('batch_2026_q1/scanned/2026-00130-CARMEN-DIAZ-ACTIVE.pdf', pdf6);

  // 7. Clean nested record 3
  const pdf7 = generateSyntheticPdf('INDIVIDUAL APPLICATION FORM', [
    { label: 'Reference Number:', value: '2026-00131' },
    { label: 'FULL NAME:', value: 'ANTONIO LUNA' },
    { label: 'STATUS:', value: 'ACTIVE' },
    { label: 'COMPLETE ADDRESS:', value: '89 General Luna Road' },
    { label: 'CITY/MUNICIPALITY:', value: 'Dapa' },
    { label: 'BARANGAY:', value: 'Barangay 01' },
    { label: 'DATE SUBMITTED:', value: '2026-03-19' },
  ]);
  zip.file('batch_2026_q1/archive/2026-00131-ANTONIO-LUNA-ACTIVE.pdf', pdf7);

  // 8. Clean nested record 4
  const pdf8 = generateSyntheticPdf('INDIVIDUAL APPLICATION FORM', [
    { label: 'Reference Number:', value: '2026-00132' },
    { label: 'FULL NAME:', value: 'TERESA MAGBANUA' },
    { label: 'STATUS:', value: 'PENDING' },
    { label: 'COMPLETE ADDRESS:', value: '33 Iloilo Highway' },
    { label: 'CITY/MUNICIPALITY:', value: 'Pototan' },
    { label: 'BARANGAY:', value: 'Barangay Rumbang' },
    { label: 'DATE SUBMITTED:', value: '2026-03-20' },
  ]);
  zip.file('batch_2026_q1/archive/2026-00132-TERESA-MAGBANUA-PENDING.pdf', pdf8);

  // Also include a non-PDF sample file to demonstrate unsupported file detection
  zip.file('batch_2026_q1/notes.txt', 'Transmittal note for Batch 2026 Q1 Civil Forms. Please review Pedro Reyes status.');

  const blob = await zip.generateAsync({ type: 'blob' });
  return blob;
}
