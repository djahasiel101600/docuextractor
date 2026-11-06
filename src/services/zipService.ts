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
  /** Populated only when the item came from a multi-archive batch upload, so
   *  the Discovered Documents list can show which ZIP each file originated from. */
  archiveName?: string;
}

export interface ArchiveDiscoveryResult {
  zipName: string;
  totalFiles: number;
  pdfFiles: DiscoveredFileItem[];
  unsupportedFiles: DiscoveredFileItem[];
  corruptedFiles: DiscoveredFileItem[];
  zipSizeBytes: number;
  sourceFile: Blob;
  /** The individual archives that make up this (possibly batched) discovery.
   *  Present with length > 1 only for multi-ZIP batch uploads; each entry is
   *  uploaded as its own request so no single HTTP body exceeds the proxy cap. */
  sourceArchives?: { filename: string; blob: Blob }[];
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
      // Read the uncompressed size straight from the ZIP central-directory
      // header so we can surface it in the UI without decompressing the entry.
      const uncompressedSize =
        (zipEntry as unknown as { _data?: { uncompressedSize?: number } })._data
          ?.uncompressedSize ?? 0;
      unsupportedFiles.push({
        id: `unsupported-${cleanPath}`,
        filename,
        relativePath: cleanPath,
        directory,
        sizeBytes: uncompressedSize,
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
 * Unpacks several ZIP archives and merges their discoveries into a single
 * result so the UI can show one unified list while each archive is still
 * uploaded as its own small HTTP request (batch-upload flow).
 */
export async function unpackMultipleZipArchives(
  files: File[]
): Promise<ArchiveDiscoveryResult> {
  const sourceArchives = files.map((file) => ({ filename: file.name, blob: file as Blob }));
  const perArchive = await Promise.all(
    files.map((file) => unpackZipArchive(file, file.name))
  );

  const pdfFiles: DiscoveredFileItem[] = [];
  const unsupportedFiles: DiscoveredFileItem[] = [];
  const corruptedFiles: DiscoveredFileItem[] = [];
  let zipSizeBytes = 0;

  perArchive.forEach((result, index) => {
    const archiveName = files[index].name;
    zipSizeBytes += result.zipSizeBytes;
    // Prefix ids with the archive index so the same path inside two different
    // archives still yields unique keys for React lists.
    const rekey = (item: DiscoveredFileItem, prefix: string): DiscoveredFileItem => ({
      ...item,
      id: `${prefix}-${archiveName}-${item.id}`,
      archiveName,
    });
    pdfFiles.push(...result.pdfFiles.map((item) => rekey(item, 'doc')));
    unsupportedFiles.push(...result.unsupportedFiles.map((item) => rekey(item, 'unsupported')));
    corruptedFiles.push(...result.corruptedFiles.map((item) => rekey(item, 'corrupted')));
  });

  const zipName =
    files.length === 1
      ? files[0].name
      : `batch (${files.length} archives)`;

  return {
    zipName,
    totalFiles: pdfFiles.length + unsupportedFiles.length + corruptedFiles.length,
    pdfFiles,
    unsupportedFiles,
    corruptedFiles,
    zipSizeBytes,
    sourceFile: sourceArchives[0]?.blob ?? new Blob(),
    sourceArchives,
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
