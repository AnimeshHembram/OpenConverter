/**
 * List the entry names in a ZIP file by reading only its central directory
 * (at the end of the file). Office documents (.docx, .xlsx, .pptx) and
 * OpenDocument files are ZIP archives; their entry names say which they are.
 */

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
/** Upper bound on the central directory we're willing to read. */
const MAX_DIRECTORY_BYTES = 8 * 1024 * 1024;

export async function zipEntryNames(file: Blob): Promise<string[] | null> {
  // The end record is 22 bytes plus a comment of up to 64 KB.
  const tailSize = Math.min(file.size, 22 + 65_535);
  const tail = new Uint8Array(await file.slice(file.size - tailSize).arrayBuffer());
  const view = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entries = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdSize > MAX_DIRECTORY_BYTES || cdOffset + cdSize > file.size) return null;
  const cd = new Uint8Array(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const cv = new DataView(cd.buffer);
  const names: string[] = [];
  const dec = new TextDecoder();
  let o = 0;
  for (let n = 0; n < entries && o + 46 <= cd.length; n++) {
    if (cv.getUint32(o, true) !== CD_SIG) return null;
    const nameLen = cv.getUint16(o + 28, true);
    const extraLen = cv.getUint16(o + 30, true);
    const commentLen = cv.getUint16(o + 32, true);
    names.push(dec.decode(cd.subarray(o + 46, o + 46 + nameLen)));
    o += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** Identify an Office or OpenDocument file from its ZIP entry names (and the ODF mimetype entry). */
export function officeKind(names: readonly string[], odfMimetype?: string): 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'odp' | null {
  const has = (p: string) => names.some((n) => n.startsWith(p));
  if (names.includes('[Content_Types].xml')) {
    if (has('word/')) return 'docx';
    if (has('xl/')) return 'xlsx';
    if (has('ppt/')) return 'pptx';
  }
  if (odfMimetype?.includes('opendocument.text')) return 'odt';
  if (odfMimetype?.includes('opendocument.spreadsheet')) return 'ods';
  if (odfMimetype?.includes('opendocument.presentation')) return 'odp';
  return null;
}
