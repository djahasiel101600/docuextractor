/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Configure PDF.js worker
if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}

export interface PDFTextItemWithPosition {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pageNumber: number;
}

export interface PDFPageExtractionResult {
  pageNumber: number;
  rawText: string;
  lines: string[];
  items: PDFTextItemWithPosition[];
  width: number;
  height: number;
}

export interface PDFDocumentExtractionResult {
  pageCount: number;
  fullText: string;
  pages: PDFPageExtractionResult[];
  isScannedOrInsufficientText: boolean;
  totalCharacters: number;
}

/**
 * Extracts native text and spatial layout from an ArrayBuffer of a PDF document
 */
export async function extractNativePdfData(
  fileBuffer: ArrayBuffer,
  minTextThreshold = 40
): Promise<PDFDocumentExtractionResult> {
  // Always clone buffer to prevent worker transfer from detaching caller's ArrayBuffer
  const bufferCopy = fileBuffer.slice(0);
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(bufferCopy),
    useSystemFonts: true,
  });

  const pdfDoc = await loadingTask.promise;
  const pageCount = pdfDoc.numPages;
  const pages: PDFPageExtractionResult[] = [];
  let combinedFullText = '';
  let totalCharacters = 0;

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.0 });
    const textContent = await page.getTextContent();

    const items: PDFTextItemWithPosition[] = [];
    const rawItems: Array<{ str: string; x: number; y: number; width: number; height: number }> = [];

    for (const item of textContent.items) {
      if ('str' in item && item.str) {
        const tx = item.transform[4];
        const ty = item.transform[5];
        const width = item.width || 0;
        const height = item.height || Math.abs(item.transform[3]) || 12;

        const posItem: PDFTextItemWithPosition = {
          str: item.str,
          x: Math.round(tx),
          y: Math.round(ty),
          width: Math.round(width),
          height: Math.round(height),
          pageNumber: pageNum,
        };
        items.push(posItem);
        rawItems.push(posItem);
      }
    }

    // Sort items by Y descending (top to bottom), then X ascending (left to right)
    // Group items with similar Y into lines
    const lineTolerance = 6; // px
    const sortedItems = [...rawItems].sort((a, b) => {
      if (Math.abs(b.y - a.y) > lineTolerance) {
        return b.y - a.y; // Higher Y is higher on page in PDF coordinate system
      }
      return a.x - b.x;
    });

    const lines: string[] = [];
    let currentLineY: number | null = null;
    let currentLineTokens: Array<{ str: string; x: number }> = [];

    for (const item of sortedItems) {
      if (currentLineY === null) {
        currentLineY = item.y;
        currentLineTokens.push(item);
      } else if (Math.abs(item.y - currentLineY) <= lineTolerance) {
        currentLineTokens.push(item);
      } else {
        // Line break
        currentLineTokens.sort((a, b) => a.x - b.x);
        lines.push(currentLineTokens.map((t) => t.str).join(' '));
        currentLineY = item.y;
        currentLineTokens = [item];
      }
    }
    if (currentLineTokens.length > 0) {
      currentLineTokens.sort((a, b) => a.x - b.x);
      lines.push(currentLineTokens.map((t) => t.str).join(' '));
    }

    const pageText = lines.join('\n');
    totalCharacters += pageText.replace(/\s+/g, '').length;
    combinedFullText += (combinedFullText ? '\n\n' : '') + pageText;

    pages.push({
      pageNumber: pageNum,
      rawText: pageText,
      lines,
      items,
      width: viewport.width,
      height: viewport.height,
    });
  }

  const isScannedOrInsufficientText = totalCharacters < minTextThreshold;

  return {
    pageCount,
    fullText: combinedFullText,
    pages,
    isScannedOrInsufficientText,
    totalCharacters,
  };
}

/**
 * Perform fallback OCR using Tesseract.js by rendering the first page(s) to Canvas
 */
export async function performOcrFallback(
  fileBuffer: ArrayBuffer,
  maxPages = 2,
  language = 'eng'
): Promise<{ ocrText: string; confidence?: number; error?: string }> {
  try {
    const { createWorker } = await import('tesseract.js');
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(fileBuffer) });
    const pdfDoc = await loadingTask.promise;
    const pagesToOcr = Math.min(pdfDoc.numPages, maxPages);

    let fullOcrText = '';
    let totalConfidence = 0;
    let sampleCount = 0;

    const worker = await createWorker(language);

    for (let pageNum = 1; pageNum <= pagesToOcr; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 2.0 }); // High DPI for OCR

      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');

      if (!ctx) continue;

      // Render PDF page to canvas
      await page.render({ canvasContext: ctx, viewport }).promise;

      // Run Tesseract OCR on rendered canvas
      const { data } = await worker.recognize(canvas);
      if (data.text) {
        fullOcrText += (fullOcrText ? '\n' : '') + data.text;
        if (typeof data.confidence === 'number') {
          totalConfidence += data.confidence;
          sampleCount++;
        }
      }
    }

    await worker.terminate();

    const avgConfidence = sampleCount > 0 ? Math.round((totalConfidence / sampleCount) * 10) / 10 : undefined;
    return {
      ocrText: fullOcrText.trim(),
      confidence: avgConfidence,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('OCR Fallback notice:', msg);
    return {
      ocrText: '',
      error: `OCR execution error: ${msg}`,
    };
  }
}

/**
 * Fallback renderer that draws the document's structured vector layout and fields
 * directly onto HTML5 2D canvas if PDF.js worker is blocked by browser iframe sandboxing.
 *
 * @deprecated Delete by 2026-12-11 (30 days from 2026-11-11). Drawing a
 * synthetic page turns a real render failure into something that looks like a
 * correctly displayed document, so callers must surface the error instead.
 * Reachable only through `renderPdfPageToCanvas(..., { allowFallback: true })`;
 * remove that opt-in and this function together.
 */
export function renderFallbackDocumentToCanvas(
  canvas: HTMLCanvasElement,
  scale = 1.3,
  highlightText?: string,
  fallbackData?: { filename?: string; finalValues?: Record<string, string>; rawText?: string }
): { width: number; height: number } {
  const baseWidth = 612;
  const baseHeight = 792;
  const width = Math.floor(baseWidth * scale);
  const height = Math.floor(baseHeight * scale);

  const pixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  canvas.width = Math.floor(width * pixelRatio);
  canvas.height = Math.floor(height * pixelRatio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return { width, height };

  ctx.save();
  ctx.scale(pixelRatio * scale, pixelRatio * scale);

  // 1. Crisp white paper background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, baseWidth, baseHeight);

  // 2. Outer document frame
  ctx.strokeStyle = '#2d3748';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(28, 28, 556, 736);

  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(32, 32, 548, 728);

  // 3. Top Navy Header Bar
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(36, 36, 540, 52);

  ctx.fillStyle = '#94a3b8';
  ctx.font = 'bold 8px system-ui, sans-serif';
  ctx.fillText('REPUBLIC OF THE PHILIPPINES  |  OFFICIAL CIVIL REGISTRY WORKSTATION', 50, 54);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 13px system-ui, sans-serif';
  const docTitle = (fallbackData?.filename || 'INDIVIDUAL APPLICATION FORM')
    .replace(/\.pdf$/i, '')
    .replace(/[-_]/g, ' ');
  ctx.fillText(docTitle.toUpperCase(), 50, 74);

  // Barcode badge
  ctx.fillStyle = '#334155';
  ctx.fillRect(475, 42, 90, 40);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 7px monospace';
  ctx.fillText('FORM 2026-A', 485, 58);
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '6px monospace';
  ctx.fillText('DIGITAL ARCHIVE', 485, 70);

  // 4. Section 1: Identification
  ctx.fillStyle = '#f1f5f9';
  ctx.fillRect(36, 102, 540, 18);
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.strokeRect(36, 102, 540, 150);

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 9px system-ui, sans-serif';
  ctx.fillText('SECTION I: APPLICANT IDENTIFICATION & STATUS', 46, 114);

  // Section 1 dividers
  ctx.strokeStyle = '#e2e8f0';
  ctx.beginPath();
  ctx.moveTo(36, 152);
  ctx.lineTo(576, 152);
  ctx.moveTo(36, 202);
  ctx.lineTo(576, 202);
  ctx.stroke();

  // Dynamic value lookup for any profile field
  const values = fallbackData?.finalValues || {};
  const findValue = (keys: string[], defaultVal: string): string => {
    for (const key of keys) {
      if (values[key]) return values[key];
    }
    for (const [k, v] of Object.entries(values)) {
      if (keys.some((cand) => k.toLowerCase().includes(cand)) && v) {
        return v;
      }
    }
    return defaultVal;
  };

  // Ref No
  ctx.fillStyle = '#64748b';
  ctx.font = 'bold 8px system-ui, sans-serif';
  ctx.fillText('REFERENCE NUMBER / REGISTRATION ID', 46, 130);
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 11px monospace';
  const refVal = findValue(['ref_no', 'reference', 'ref', 'registration_id', 'id'], '2026-00125');
  ctx.fillText(`Reference Number: ${refVal}`, 46, 144);

  // Full Name
  ctx.fillStyle = '#64748b';
  ctx.font = 'bold 8px system-ui, sans-serif';
  ctx.fillText('FULL LEGAL NAME OF REGISTRANT', 46, 172);
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 12px system-ui, sans-serif';
  const nameVal = findValue(['full_name', 'name', 'applicant', 'registrant'], 'JUAN DELA CRUZ');
  ctx.fillText(`FULL NAME: ${nameVal}`, 46, 190);

  // Status
  ctx.fillStyle = '#64748b';
  ctx.font = 'bold 8px system-ui, sans-serif';
  ctx.fillText('REGISTRATION STATUS CLASSIFICATION', 46, 222);
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 11px monospace';
  const statusVal = findValue(['status', 'state', 'classification'], 'ACTIVE');
  ctx.fillText(`STATUS: ${statusVal}`, 46, 238);

  // Status Stamp
  const isInactive = statusVal.toUpperCase().includes('INACTIVE');
  const isPending = statusVal.toUpperCase().includes('PENDING');
  ctx.fillStyle = isInactive ? '#fee2e2' : isPending ? '#fef3c7' : '#dcfce7';
  ctx.fillRect(440, 218, 120, 24);
  ctx.strokeStyle = isInactive ? '#dc2626' : isPending ? '#d97706' : '#16a34a';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(440, 218, 120, 24);
  ctx.fillStyle = isInactive ? '#991b1b' : isPending ? '#92400e' : '#166534';
  ctx.font = 'bold 9px monospace';
  ctx.fillText(isInactive ? '[ INACTIVE ]' : isPending ? '[ PENDING ]' : '[ ACTIVE ]', 465, 233);

  // 5. Section 2: Residential Address
  ctx.fillStyle = '#f1f5f9';
  ctx.fillRect(36, 268, 540, 18);
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.strokeRect(36, 268, 540, 140);

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 9px system-ui, sans-serif';
  ctx.fillText('SECTION II: RESIDENTIAL ADDRESS & LOCAL JURISDICTION', 46, 280);

  ctx.strokeStyle = '#e2e8f0';
  ctx.beginPath();
  ctx.moveTo(36, 316);
  ctx.lineTo(576, 316);
  ctx.moveTo(36, 362);
  ctx.lineTo(576, 362);
  ctx.stroke();

  // Address line
  ctx.fillStyle = '#64748b';
  ctx.font = 'bold 8px system-ui, sans-serif';
  ctx.fillText('PERMANENT RESIDENCE / STREET ADDRESS', 46, 296);
  ctx.fillStyle = '#0f172a';
  ctx.font = '10px system-ui, sans-serif';
  const addressVal = findValue(['address', 'complete_address', 'residence', 'street'], '124 Rizal Avenue');
  ctx.fillText(`COMPLETE ADDRESS: ${addressVal}`, 46, 308);

  // City
  ctx.fillStyle = '#64748b';
  ctx.font = 'bold 8px system-ui, sans-serif';
  ctx.fillText('CITY / MUNICIPALITY', 46, 334);
  ctx.fillStyle = '#0f172a';
  ctx.font = '10px system-ui, sans-serif';
  const cityVal = findValue(['city', 'municipality', 'city_municipality'], 'Cabadbaran City');
  ctx.fillText(`CITY/MUNICIPALITY: ${cityVal}`, 46, 350);

  // Barangay
  ctx.fillStyle = '#64748b';
  ctx.font = 'bold 8px system-ui, sans-serif';
  ctx.fillText('BARANGAY / ADMINISTRATIVE SUB-DISTRICT', 46, 380);
  ctx.fillStyle = '#0f172a';
  ctx.font = '10px system-ui, sans-serif';
  const brgyVal = findValue(['barangay', 'brgy', 'district'], 'Barangay Poblacion 2');
  ctx.fillText(`BARANGAY: ${brgyVal}`, 46, 396);

  // 6. Section 3: Filing Particulars
  ctx.fillStyle = '#f1f5f9';
  ctx.fillRect(36, 424, 540, 18);
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.strokeRect(36, 424, 540, 100);

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 9px system-ui, sans-serif';
  ctx.fillText('SECTION III: FILING PARTICULARS & REGISTRATION TRANSCRIPT', 46, 436);

  ctx.fillStyle = '#64748b';
  ctx.font = 'bold 8px system-ui, sans-serif';
  ctx.fillText('DATE SUBMITTED', 46, 458);
  ctx.fillStyle = '#0f172a';
  ctx.font = '10px monospace';
  const dateVal = findValue(['date_submitted', 'date', 'submission_date', 'filing_date'], '2026-03-14');
  ctx.fillText(`DATE SUBMITTED: ${dateVal}`, 46, 474);

  // 7. Official Legal Certification Box
  ctx.fillStyle = '#fafafa';
  ctx.fillRect(36, 540, 540, 120);
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1;
  ctx.strokeRect(36, 540, 540, 120);

  ctx.fillStyle = '#1e293b';
  ctx.font = 'bold 8px system-ui, sans-serif';
  ctx.fillText('CERTIFICATION OF OFFICIAL RECORD:', 46, 560);
  ctx.fillStyle = '#475569';
  ctx.font = '7.5px system-ui, sans-serif';
  ctx.fillText('I hereby affirm under penalty of legal invalidation that all particulars recorded above have been verified.', 46, 574);
  ctx.fillText('This electronic PDF document transcript conforms to civil registry data standards.', 46, 586);

  // Signature line
  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(380, 620);
  ctx.lineTo(550, 620);
  ctx.stroke();
  ctx.fillStyle = '#64748b';
  ctx.font = '7px system-ui, sans-serif';
  ctx.fillText('AUTHORIZED REGISTRAR SIGNATURE', 400, 632);

  // Official Stamp Box
  ctx.strokeStyle = '#0284c7';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(46, 600, 110, 42);
  ctx.fillStyle = '#0369a1';
  ctx.font = 'bold 8px system-ui, sans-serif';
  ctx.fillText('OFFICIALLY FILED', 55, 618);
  ctx.font = '6.5px monospace';
  ctx.fillText('DIGITAL ARCHIVE 2026', 55, 630);

  // Footer bar
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(36, 730);
  ctx.lineTo(576, 730);
  ctx.stroke();

  ctx.fillStyle = '#64748b';
  ctx.font = '7px monospace';
  ctx.fillText('Document ID: 2026-FORM-REG-V2  |  Form Page 1 of 1  |  Security Hash: 8F92-BC44-77AE', 46, 745);

  // Highlight active field if specified
  if (highlightText && highlightText.trim().length > 1) {
    const q = highlightText.trim().toLowerCase();
    let hlY = -1;
    if (refVal.toLowerCase().includes(q)) hlY = 136;
    else if (nameVal.toLowerCase().includes(q)) hlY = 180;
    else if (statusVal.toLowerCase().includes(q)) hlY = 226;
    else if (addressVal.toLowerCase().includes(q)) hlY = 298;
    else if (cityVal.toLowerCase().includes(q)) hlY = 340;
    else if (brgyVal.toLowerCase().includes(q)) hlY = 386;
    else if (dateVal.toLowerCase().includes(q)) hlY = 464;

    if (hlY > 0) {
      ctx.fillStyle = 'rgba(250, 204, 21, 0.4)';
      ctx.strokeStyle = 'rgba(217, 119, 6, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.fillRect(40, hlY, 260, 20);
      ctx.strokeRect(40, hlY, 260, 20);
    }
  }

  ctx.restore();
  return { width, height };
}

/**
 * Render a single PDF page to a canvas element for document inspection.
 *
 * `fallbackData`/`allowFallback` exist only for surfaces that intentionally
 * accept a synthetic page. Callers that rely on the canvas geometry (the
 * profile wizard's annotation surface, verification views) MUST leave
 * `allowFallback` false: a synthetic page silently drawn over a broken render
 * looks like real content while carrying fabricated geometry and values.
 */
export async function renderPdfPageToCanvas(
  fileBuffer: ArrayBuffer,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale = 1.3,
  highlightText?: string,
  fallbackData?: { filename?: string; finalValues?: Record<string, string>; rawText?: string },
  options?: { allowFallback?: boolean }
): Promise<{ width: number; height: number }> {
  try {
    const bufferCopy = fileBuffer.slice(0);
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(bufferCopy),
      useSystemFonts: true,
    });
    const pdfDoc = await loadingTask.promise;
    const page = await pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });

    const outputScale = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');

    // 1. Fill solid crisp white paper background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 2. Render actual PDF graphics and fonts using transform for HiDPI
    const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
    await page.render({
      canvasContext: ctx,
      transform,
      viewport,
    }).promise;

    // 3. Highlight active field text if present
    if (highlightText && highlightText.trim().length > 1) {
      try {
        const textContent = await page.getTextContent();
        const targetQuery = highlightText.trim().toLowerCase();

        for (const item of textContent.items) {
          if ('str' in item && item.str) {
            const itemText = item.str.toLowerCase();
            if (itemText.includes(targetQuery) || targetQuery.includes(itemText)) {
              const tx = item.transform[4];
              const ty = item.transform[5];
              const itemWidth = item.width || 60;
              const itemHeight = item.height || Math.abs(item.transform[3]) || 14;

              const [vx, vy] = viewport.convertToViewportPoint(tx, ty + itemHeight);
              const scaledWidth = itemWidth * (viewport.scale / (item.transform[0] || 1));
              const scaledHeight = itemHeight * (viewport.scale / Math.abs(item.transform[3] || 1));

              ctx.save();
              if (outputScale !== 1) {
                ctx.scale(outputScale, outputScale);
              }
              ctx.fillStyle = 'rgba(250, 204, 21, 0.35)';
              ctx.strokeStyle = 'rgba(217, 119, 6, 0.85)';
              ctx.lineWidth = 1.5;

              ctx.fillRect(vx - 2, vy - 2, scaledWidth + 4, scaledHeight + 4);
              ctx.strokeRect(vx - 2, vy - 2, scaledWidth + 4, scaledHeight + 4);
              ctx.restore();
            }
          }
        }
      } catch {
        // Highlighting overlay catch
      }
    }

    return { width: viewport.width, height: viewport.height };
  } catch (err: unknown) {
    if (options?.allowFallback) {
      // Explicit opt-in only: draw the synthetic document instead of failing.
      return renderFallbackDocumentToCanvas(canvas, scale, highlightText, fallbackData);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`PDF page ${pageNumber} could not be rendered: ${reason}`);
  }
}
