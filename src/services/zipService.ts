/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import JSZip from 'jszip';

export interface DiscoveredFileItem {
  id: string;
  filename: string;
  relativePath: string;
  directory: string;
  sizeBytes: number;
  isPdf: boolean;
  isUnsupported: boolean;
  isEncryptedOrCorrupted: boolean;
  fileData?: ArrayBuffer;
}

export interface ArchiveDiscoveryResult {
  zipName: string;
  totalFiles: number;
  pdfFiles: DiscoveredFileItem[];
  unsupportedFiles: DiscoveredFileItem[];
  corruptedFiles: DiscoveredFileItem[];
  zipSizeBytes: number;
  sourceFile: Blob;
}

/**
 * Sanitizes relative paths to prevent path traversal
 */
export function sanitizePath(rawPath: string): string {
  return rawPath
    .replace(/^(\.\.(\/|\\|$))+/, '')
    .replace(/[/\\]+/g, '/')
    .replace(/^\//, '');
}

/**
 * Inspects and unpacks a ZIP archive file or File object
 */
export async function unpackZipArchive(
  file: File | Blob,
  zipName = 'archive.zip'
): Promise<ArchiveDiscoveryResult> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = new JSZip();
  let loadedZip: JSZip;

  try {
    loadedZip = await zip.loadAsync(arrayBuffer);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read ZIP archive: ${errorMsg}. File might be corrupted or password-protected.`);
  }

  const pdfFiles: DiscoveredFileItem[] = [];
  const unsupportedFiles: DiscoveredFileItem[] = [];
  const corruptedFiles: DiscoveredFileItem[] = [];

  const fileEntries = Object.keys(loadedZip.files);

  for (const rawPath of fileEntries) {
    const zipEntry = loadedZip.files[rawPath];
    if (zipEntry.dir) continue; // Skip pure directory entries

    const cleanPath = sanitizePath(rawPath);
    const pathParts = cleanPath.split('/');
    const filename = pathParts[pathParts.length - 1];
    const directory = pathParts.slice(0, -1).join('/') || '/';

    // Skip OS junk files like __MACOSX or .DS_Store
    if (filename.startsWith('.') || cleanPath.includes('__MACOSX/')) {
      continue;
    }

    const isPdf = filename.toLowerCase().endsWith('.pdf');

    if (!isPdf) {
      unsupportedFiles.push({
        id: `unsupported-${cleanPath}`,
        filename,
        relativePath: cleanPath,
        directory,
        sizeBytes: 0,
        isPdf: false,
        isUnsupported: true,
        isEncryptedOrCorrupted: false,
      });
      continue;
    }

    try {
      const buffer = await zipEntry.async('arraybuffer');
      pdfFiles.push({
        id: `doc-${cleanPath}`,
        filename,
        relativePath: cleanPath,
        directory,
        sizeBytes: buffer.byteLength,
        isPdf: true,
        isUnsupported: false,
        isEncryptedOrCorrupted: false,
        fileData: buffer,
      });
    } catch {
      corruptedFiles.push({
        id: `corrupted-${cleanPath}`,
        filename,
        relativePath: cleanPath,
        directory,
        sizeBytes: 0,
        isPdf: true,
        isUnsupported: false,
        isEncryptedOrCorrupted: true,
      });
    }
  }

  return {
    zipName,
    totalFiles: pdfFiles.length + unsupportedFiles.length + corruptedFiles.length,
    pdfFiles,
    unsupportedFiles,
    corruptedFiles,
    zipSizeBytes: arrayBuffer.byteLength,
    sourceFile: file,
  };
}

/**
 * Handles multiple loose PDF files uploaded directly through file picker
 */
export async function collectLoosePdfFiles(files: File[]): Promise<ArchiveDiscoveryResult> {
  const zip = new JSZip();
  const pdfFiles: DiscoveredFileItem[] = [];
  const unsupportedFiles: DiscoveredFileItem[] = [];
  let totalBytes = 0;

  for (const f of files) {
    const isPdf = f.name.toLowerCase().endsWith('.pdf');
    if (isPdf) {
      const buf = await f.arrayBuffer();
      totalBytes += buf.byteLength;
      zip.file(f.name, f);
      pdfFiles.push({
        id: `doc-${f.name}-${Date.now()}`,
        filename: f.name,
        relativePath: f.name,
        directory: '/',
        sizeBytes: buf.byteLength,
        isPdf: true,
        isUnsupported: false,
        isEncryptedOrCorrupted: false,
        fileData: buf,
      });
    } else {
      unsupportedFiles.push({
        id: `unsupported-${f.name}`,
        filename: f.name,
        relativePath: f.name,
        directory: '/',
        sizeBytes: f.size,
        isPdf: false,
        isUnsupported: true,
        isEncryptedOrCorrupted: false,
      });
    }
  }

  const zipName =
    files.length === 1 ? files[0].name.replace(/\.pdf$/i, '.zip') : `batch-${Date.now()}.zip`;
  const sourceFile = await zip.generateAsync({ type: 'blob' });

  return {
    zipName,
    totalFiles: files.length,
    pdfFiles,
    unsupportedFiles,
    corruptedFiles: [],
    zipSizeBytes: sourceFile.size || totalBytes,
    sourceFile,
  };
}
