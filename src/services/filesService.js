// services/filesService.js
// File upload / storage / extraction lifecycle.
// Status: uploading → extracting → processed | failed
// On first file processed → triggers summary enqueue + RAG chunking.

const supabase = require('../lib/supabaseClient');
const { AppError } = require('../lib/errors');
const { HTTP_STATUS, ERROR_CODES, FILES } = require('../config/constants');

// Lazy-require heavy parsers so server boot stays fast
let pdfParse = null;
let mammoth = null;
let officeparser = null;

function getPdfParse() {
  if (!pdfParse) pdfParse = require('pdf-parse');
  return pdfParse;
}
function getMammoth() {
  if (!mammoth) mammoth = require('mammoth');
  return mammoth;
}
function getOfficeparser() {
  if (!officeparser) officeparser = require('officeparser');
  return officeparser;
}

// ---------------------------------------------------------------------------
// Extract text from buffer by mime type
// ---------------------------------------------------------------------------

async function extractText(buffer, mimeType, filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();

  if (mimeType === 'application/pdf' || ext === 'pdf') {
    try {
      const data = await getPdfParse()(buffer);
      return { text: data.text || '', needsOcr: false };
    } catch (err) {
      console.error('[filesService] pdf-parse error:', err.message);
      return { text: '', needsOcr: false, error: err.message };
    }
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  ) {
    try {
      const result = await getMammoth().extractRawText({ buffer });
      return { text: result.value || '', needsOcr: false };
    } catch (err) {
      console.error('[filesService] mammoth error:', err.message);
      return { text: '', needsOcr: false, error: err.message };
    }
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    ['pptx', 'xlsx'].includes(ext)
  ) {
    try {
      const op = getOfficeparser();
      // officeparser accepts buffer or path; use parseOfficeAsync with buffer
      const text = await new Promise((resolve, reject) => {
        op.parseOffice(buffer, (data, err) => {
          if (err) reject(err);
          else resolve(data || '');
        }, { outputErrorToConsole: false });
      });
      return { text: String(text || ''), needsOcr: false };
    } catch (err) {
      console.error('[filesService] officeparser error:', err.message);
      return { text: '', needsOcr: false, error: err.message };
    }
  }

  if (mimeType === 'text/plain' || ext === 'txt') {
    return { text: buffer.toString('utf8'), needsOcr: false };
  }

  if (['image/png', 'image/jpeg'].includes(mimeType) || ['png', 'jpg', 'jpeg'].includes(ext)) {
    // OCR not bundled — mark as needs_ocr, extract empty
    return { text: '', needsOcr: true };
  }

  return { text: '', needsOcr: false, error: 'Unrecognized file type' };
}

// ---------------------------------------------------------------------------
// Upload buffer to Supabase Storage
// ---------------------------------------------------------------------------

async function uploadToStorage({ buffer, filename, mimeType, spaceId, fileId }) {
  const path = `${spaceId}/${fileId}/${filename}`;
  const { error } = await supabase.storage
    .from(FILES.STORAGE_BUCKET)
    .upload(path, buffer, { contentType: mimeType, upsert: false });
  if (error) throw new Error(error.message);

  const { data: urlData } = supabase.storage
    .from(FILES.STORAGE_BUCKET)
    .getPublicUrl(path);
  return urlData?.publicUrl || null;
}

// ---------------------------------------------------------------------------
// Set file status in DB
// ---------------------------------------------------------------------------

async function setFileStatus(fileId, status, extra = {}) {
  const { error } = await supabase
    .from('files')
    .update({ status, updated_at: new Date().toISOString(), ...extra })
    .eq('id', fileId);
  if (error) console.error('[filesService] setFileStatus error:', error.message);
}

// ---------------------------------------------------------------------------
// Post-extraction: trigger summary + RAG chunking async (fire-and-forget)
// ---------------------------------------------------------------------------

async function triggerPostProcessing(spaceId, fileId, extractedText) {
  // Trigger summary enqueue (only once per space when first file is processed)
  try {
    const summaryService = require('./summaryService');
    await summaryService.enqueue(spaceId);
  } catch (err) {
    console.error('[filesService] summary enqueue error:', err.message);
  }

  // Trigger RAG chunking
  try {
    const chunkingService = require('./chunkingService');
    await chunkingService.persistChunksForFile({
      fileId,
      spaceId,
      extractedText,
      sourceKind: 'file',
    });
  } catch (err) {
    console.error('[filesService] chunking error:', err.message);
  }

  // Log activity: file upload = 2 minutes
  try {
    const progressService = require('./progressService');
    // We need uploader_id — fetch it
    const { data: file } = await supabase
      .from('files')
      .select('uploader_id')
      .eq('id', fileId)
      .maybeSingle();
    if (file?.uploader_id) {
      await progressService.logActivity(spaceId, file.uploader_id, 'file_upload', 2);
    }
  } catch (err) {
    console.error('[filesService] logActivity error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Run extraction in background (async, non-blocking for the HTTP response)
// ---------------------------------------------------------------------------

async function runExtractionAsync({ fileId, spaceId, buffer, mimeType, filename }) {
  await setFileStatus(fileId, FILES.STATUS.EXTRACTING);

  let extractedText = '';
  let needsOcr = false;
  let extractionError = null;

  try {
    const result = await extractText(buffer, mimeType, filename);
    extractedText = result.text || '';
    needsOcr = result.needsOcr || false;
    if (result.error) extractionError = result.error;
  } catch (err) {
    extractionError = err.message;
  }

  const maxChars = FILES.MAX_EXTRACTED_TEXT_CHARS || 2_000_000;
  const truncated = extractedText.length > maxChars;
  const finalText = extractedText.slice(0, maxChars);
  const charCount = extractedText.length;

  if (extractionError && !needsOcr) {
    await setFileStatus(fileId, FILES.STATUS.FAILED, {
      error_message: extractionError,
    });
    return;
  }

  await setFileStatus(fileId, FILES.STATUS.PROCESSED, {
    extracted_text: finalText,
    text_truncated: truncated,
    char_count: charCount,
    needs_ocr: needsOcr,
    error_message: null,
  });

  // Fire post-processing (summary + RAG) asynchronously — don't await
  if (finalText.trim()) {
    triggerPostProcessing(spaceId, fileId, finalText).catch(err =>
      console.error('[filesService] triggerPostProcessing error:', err.message)
    );
  }
}

// ---------------------------------------------------------------------------
// Public: uploadFile
// ---------------------------------------------------------------------------

async function uploadFile({ spaceId, userId, buffer, originalname, mimetype, size }) {
  // Validate mime
  if (!FILES.SUPPORTED_MIME_TYPES.includes(mimetype)) {
    throw new AppError({
      code: ERROR_CODES.UNSUPPORTED_FILE_TYPE,
      message: `File type '${mimetype}' is not supported. Supported types: PDF, DOCX, PPTX, TXT, PNG, JPG.`,
      status: HTTP_STATUS.BAD_REQUEST,
    });
  }

  // Validate size
  if (size > FILES.MAX_SIZE_BYTES) {
    throw new AppError({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: `File exceeds maximum size of ${Math.round(FILES.MAX_SIZE_BYTES / 1024 / 1024)} MB.`,
      status: HTTP_STATUS.BAD_REQUEST,
    });
  }

  // Create files row with status = uploading
  let fileRow = null;
  const fileInsert = {
    space_id: spaceId,
    uploader_id: userId,
    source_kind: 'upload',
    display_name: originalname,
    file_extension: originalname.split('.').pop().toLowerCase(),
    mime_type: mimetype,
    size_bytes: size,
    status: FILES.STATUS.UPLOADING,
    extracted_text: null,
    text_truncated: false,
    char_count: 0,
    needs_ocr: false,
  };

  const { data, error: insertError } = await supabase
    .from('files')
    .insert(fileInsert)
    .select('*')
    .maybeSingle();

  if (insertError || !data) {
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: insertError?.message || 'Failed to create file record',
      status: HTTP_STATUS.INTERNAL,
    });
  }
  fileRow = data;

  // Upload to storage (async; if it fails, mark failed)
  let storageUrl = null;
  try {
    storageUrl = await uploadToStorage({
      buffer,
      filename: originalname,
      mimeType: mimetype,
      spaceId,
      fileId: fileRow.id,
    });
    await setFileStatus(fileRow.id, FILES.STATUS.EXTRACTING, {
      storage_url: storageUrl,
    });
  } catch (err) {
    console.error('[filesService] storage upload error:', err.message);
    await setFileStatus(fileRow.id, FILES.STATUS.FAILED, {
      error_message: 'Storage upload failed: ' + err.message,
    });
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: 'Failed to upload file to storage',
      status: HTTP_STATUS.INTERNAL,
    });
  }

  // Run extraction asynchronously — return the file row immediately
  runExtractionAsync({
    fileId: fileRow.id,
    spaceId,
    buffer,
    mimeType: mimetype,
    filename: originalname,
  }).catch(err => {
    console.error('[filesService] runExtractionAsync uncaught error:', err.message);
    setFileStatus(fileRow.id, FILES.STATUS.FAILED, { error_message: err.message });
  });

  return { ...fileRow, status: FILES.STATUS.EXTRACTING, storage_url: storageUrl };
}

// ---------------------------------------------------------------------------
// Public: createTextFile (pasted text — skips storage)
// ---------------------------------------------------------------------------

async function createTextFile({ spaceId, userId, text, displayName }) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AppError({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'text body is required and must be non-empty',
      status: HTTP_STATUS.BAD_REQUEST,
    });
  }

  const maxChars = FILES.MAX_EXTRACTED_TEXT_CHARS || 2_000_000;
  const truncated = text.length > maxChars;
  const finalText = text.slice(0, maxChars);

  const fileInsert = {
    space_id: spaceId,
    uploader_id: userId,
    source_kind: 'pasted_text',
    display_name: displayName || 'Pasted Text',
    file_extension: 'txt',
    mime_type: 'text/plain',
    size_bytes: Buffer.byteLength(finalText, 'utf8'),
    status: FILES.STATUS.PROCESSED,
    extracted_text: finalText,
    text_truncated: truncated,
    char_count: text.length,
    needs_ocr: false,
  };

  const { data, error } = await supabase
    .from('files')
    .insert(fileInsert)
    .select('*')
    .maybeSingle();

  if (error || !data) {
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: error?.message || 'Failed to create text file record',
      status: HTTP_STATUS.INTERNAL,
    });
  }

  // Trigger post-processing (summary + RAG) async
  triggerPostProcessing(spaceId, data.id, finalText).catch(err =>
    console.error('[filesService] triggerPostProcessing error for text:', err.message)
  );

  return data;
}

// ---------------------------------------------------------------------------
// Public: listFiles
// ---------------------------------------------------------------------------

async function listFiles({ spaceId }) {
  const { data, error } = await supabase
    .from('files')
    .select('id, display_name, mime_type, size_bytes, status, error_message, char_count, text_truncated, needs_ocr, source_kind, created_at, updated_at')
    .eq('space_id', spaceId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: error.message || 'Failed to list files',
      status: HTTP_STATUS.INTERNAL,
    });
  }
  return data || [];
}

// ---------------------------------------------------------------------------
// Public: deleteFile
// ---------------------------------------------------------------------------

async function deleteFile({ spaceId, fileId, userId }) {
  // Verify space ownership
  const { data: space, error: spaceErr } = await supabase
    .from('study_spaces')
    .select('owner_id')
    .eq('id', spaceId)
    .maybeSingle();

  if (spaceErr || !space) {
    throw new AppError({ code: ERROR_CODES.NOT_FOUND, message: 'Space not found', status: HTTP_STATUS.NOT_FOUND });
  }
  if (space.owner_id !== userId) {
    throw new AppError({ code: ERROR_CODES.FORBIDDEN, message: 'Only the owner can delete files', status: HTTP_STATUS.FORBIDDEN });
  }

  const { error } = await supabase
    .from('files')
    .delete()
    .eq('id', fileId)
    .eq('space_id', spaceId);

  if (error) {
    throw new AppError({
      code: ERROR_CODES.INTERNAL,
      message: error.message || 'Failed to delete file',
      status: HTTP_STATUS.INTERNAL,
    });
  }
}

module.exports = {
  uploadFile,
  createTextFile,
  listFiles,
  deleteFile,
};
