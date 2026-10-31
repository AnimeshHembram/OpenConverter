/**
 * OpenConverter's pdf.js worker: pdf.js's own worker, with ReadableStream
 * async iteration added first for browsers that lack it (Safari 26 and
 * earlier; see stream-iterator.ts). Modules run in import order, so the
 * iterator is in place before pdf.js loads; pdf.js then sets up its message
 * handler itself, as it does when loaded directly as a worker.
 */
import './install-stream-iterator';
import 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
