import * as XLSX from "xlsx";
import { supabase } from "../lib/supabase";

const API_BASE_URL = String(process.env.REACT_APP_API_BASE_URL || "").replace(/\/+$/, "");

const MAX_IMPORT_ROWS = 300_000;
const BATCH_SIZE = 250;
const BATCH_DELAY_MS = 60;
const MAX_BATCH_RETRIES = 6;
const MAX_FINISH_RETRIES = 4;
const PARSE_YIELD_EVERY_ROWS = 2_000;

const HEADER_ALIASES = {
  artigo: ["Artigo", "artigo_interno", "codigo", "código", "Nosso Codigo", "Nosso Código"],
  descricao: ["Descricao", "Descrição"],
  pvp1: ["PVP1", "PVP 1"],
  pvp2: ["PVP2", "PVP 2"],
  pvp3: ["PVP3", "PVP 3"],
  estado: ["Estado", "Status"],
  codigoBarras: [
    "Cód. Barras",
    "Cod. Barras",
    "Código de Barras",
    "Codigo de Barras",
    "Código Barras",
    "Codigo Barras",
    "EAN",
    "EAN13",
    "EAN-13",
  ],
};

function normalizeHeader(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function clean(value) {
  return String(value ?? "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePrice(value) {
  const cleanValue = clean(value).replace(/[^\d,.-]/g, "");
  if (!cleanValue || cleanValue === "-") return "";
  return cleanValue;
}

function aliasesFor(field) {
  return new Set((HEADER_ALIASES[field] || []).map(normalizeHeader));
}

function buildColumnMap(headers) {
  const normalized = headers.map(normalizeHeader);
  const result = {};

  for (const field of Object.keys(HEADER_ALIASES)) {
    const aliases = aliasesFor(field);
    result[field] = normalized.findIndex((header) => aliases.has(header));
  }

  return result;
}

function buildNormalizedRow(values, columns) {
  const row = {};
  const read = (field) => {
    const index = columns[field];
    return Number.isInteger(index) && index >= 0 ? clean(values[index]) : undefined;
  };

  const artigo = read("artigo");
  if (!artigo) return null;

  row.artigo = artigo;

  const descricao = read("descricao");
  if (descricao !== undefined) row.descricao = descricao;

  const pvp1 = read("pvp1");
  if (pvp1 !== undefined) row.pvp1 = normalizePrice(pvp1);

  const pvp2 = read("pvp2");
  const normalizedPvp2 =
    pvp2 !== undefined ? normalizePrice(pvp2) : "";

  // Regra de importação: só entram artigos com PVP2 preenchido.
  // Se PVP2 estiver vazio/nulo, ignora-se a linha completa.
  if (!normalizedPvp2) {
    return null;
  }

  row.pvp2 = normalizedPvp2;

  const pvp3 = read("pvp3");
  if (pvp3 !== undefined) row.pvp3 = normalizePrice(pvp3);

  const estado = read("estado");
  if (estado !== undefined) row.estado = estado;

  const codigoBarras = read("codigoBarras");
  if (codigoBarras !== undefined) row.codigoBarras = codigoBarras;

  return row;
}

async function accessToken() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw new Error(error.message || "Sessão inválida.");
  if (!data?.session?.access_token) {
    throw new Error("Sessão expirada. Inicia sessão novamente.");
  }
  return data.session.access_token;
}

class SyncApiError extends Error {
  constructor(message, { status = 0, retryAfterSeconds = 0, code = "" } = {}) {
    super(message);
    this.name = "SyncApiError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.code = code;
  }
}

function retryDelayMs(attempt, retryAfterSeconds = 0) {
  if (retryAfterSeconds > 0) {
    return Math.min(Math.max(retryAfterSeconds * 1000, 1_000), 120_000);
  }

  const exponential = 800 * (2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 350);
  return Math.min(exponential + jitter, 20_000);
}

function shouldRetryResponse(status, code = "") {
  const numericStatus = Number(status);
  const normalizedCode = String(code || "").toUpperCase();

  if ([408, 425, 429, 502, 503, 504].includes(numericStatus)) {
    return true;
  }

  if (numericStatus !== 500) {
    return false;
  }

  // PostgreSQL/Supabase deterministic data errors will not heal by retrying.
  if (
    [
      "23505", // unique_violation
      "21000", // cardinality_violation / same ON CONFLICT row twice
      "23502", // not_null_violation
      "23503", // foreign_key_violation
      "22P02", // invalid_text_representation
      "42703", // undefined_column
      "42P01", // undefined_table
    ].includes(normalizedCode)
  ) {
    return false;
  }

  // Timeouts and generic infrastructure 500s are retryable.
  return (
    normalizedCode === "57014" ||
    normalizedCode === "INTERNAL_ERROR" ||
    normalizedCode === "" ||
    normalizedCode.startsWith("PGRST")
  );
}

async function api(path, options = {}, { maxRetries = 0, onRetry } = {}) {
  let attempt = 0;

  while (true) {
    let response;

    try {
      const token = await accessToken();
      response = await fetch(`${API_BASE_URL}${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(options.headers || {}),
        },
      });
    } catch (networkError) {
      if (attempt >= maxRetries) {
        throw new SyncApiError(
          networkError?.message || "Falha de ligação durante a sincronização.",
          { status: 0 },
        );
      }

      attempt += 1;
      const delayMs = retryDelayMs(attempt);
      onRetry?.({ attempt, maxRetries, delayMs, reason: "Falha de ligação" });
      await sleep(delayMs);
      continue;
    }

    const data = await response.json().catch(() => ({}));

    if (response.ok && data?.ok !== false) {
      return data;
    }

    const retryAfterHeader = Number(response.headers.get("Retry-After") || 0);
    const retryAfterSeconds = Number(
      data?.retryAfterSeconds ||
      data?.error?.retryAfterSeconds ||
      retryAfterHeader ||
      0,
    );

    const message =
      data?.error?.message ||
      data?.error ||
      `Erro HTTP ${response.status}`;

    const error = new SyncApiError(message, {
      status: response.status,
      retryAfterSeconds,
      code: data?.error?.code || "",
    });

    if (!shouldRetryResponse(response.status, error.code) || attempt >= maxRetries) {
      throw error;
    }

    attempt += 1;
    const delayMs = retryDelayMs(attempt, retryAfterSeconds);

    onRetry?.({
      attempt,
      maxRetries,
      delayMs,
      reason: message,
      status: response.status,
    });

    await sleep(delayMs);
  }
}

function aggregateFromTotals(totals = {}, fallback = null) {
  if (!totals || typeof totals !== "object") return fallback;

  return {
    processed: Number(totals.processed_rows || 0),
    updated: Number(totals.updated_rows || 0),
    inserted: Number(totals.inserted_rows || 0),
    unchanged: Number(totals.unchanged_rows || 0),
    changedFields: {
      pvp1: Number(totals.pvp1_changes || 0),
      pvp2: Number(totals.pvp2_changes || 0),
      pvp3: Number(totals.pvp3_changes || 0),
      estado: Number(totals.estado_changes || 0),
    },
  };
}

/* =========================================================
   ODS STREAMING
   ========================================================= */

function decodeXmlEntities(value = "") {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_match, number) =>
      String.fromCodePoint(Number(number)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, number) =>
      String.fromCodePoint(Number.parseInt(number, 16)),
    );
}

function textFromOdsCell(body = "") {
  let value = String(body || "");

  value = value.replace(
    /<text:s\b[^>]*text:c="(\d+)"[^>]*\/>/g,
    (_match, count) => " ".repeat(Math.min(Number(count) || 1, 1000)),
  );
  value = value.replace(/<text:s\b[^>]*\/>/g, " ");
  value = value.replace(/<text:tab\b[^>]*\/>/g, "\t");
  value = value.replace(/<text:line-break\b[^>]*\/>/g, "\n");
  value = value.replace(/<[^>]+>/g, "");

  return decodeXmlEntities(value).trim();
}

function parseOdsRowXml(rowXml) {
  const values = [];
  const cellRegex =
    /<table:(table-cell|covered-table-cell)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:\1>)/g;

  let match;

  while ((match = cellRegex.exec(rowXml))) {
    const attributes = match[2] || "";
    const body = match[3] || "";
    const repeated = attributes.match(
      /table:number-columns-repeated="(\d+)"/,
    );

    const repeatCount = Math.max(
      1,
      Math.min(Number(repeated?.[1] || 1), 100_000),
    );

    const value = textFromOdsCell(body);

    // We only need the first useful columns. This also protects against ODS
    // files that encode thousands of repeated empty cells at the end of a row.
    const take = Math.min(repeatCount, 64 - values.length);

    for (let index = 0; index < take; index += 1) {
      values.push(value);
    }

    if (values.length >= 64) break;
  }

  return values;
}

async function findZipEntry(file, targetName) {
  // End Of Central Directory is at most 65,557 bytes from EOF.
  const tailSize = Math.min(file.size, 22 + 0xffff + 4096);
  const tailOffset = file.size - tailSize;
  const tail = new Uint8Array(
    await file.slice(tailOffset).arrayBuffer(),
  );
  const tailView = new DataView(
    tail.buffer,
    tail.byteOffset,
    tail.byteLength,
  );

  let eocdOffset = -1;

  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tailView.getUint32(index, true) === 0x06054b50) {
      eocdOffset = index;
      break;
    }
  }

  if (eocdOffset < 0) {
    throw new Error("O ficheiro ODS não contém um ZIP válido.");
  }

  const centralDirectorySize = tailView.getUint32(
    eocdOffset + 12,
    true,
  );
  const centralDirectoryOffset = tailView.getUint32(
    eocdOffset + 16,
    true,
  );

  const central = new Uint8Array(
    await file
      .slice(
        centralDirectoryOffset,
        centralDirectoryOffset + centralDirectorySize,
      )
      .arrayBuffer(),
  );

  const centralView = new DataView(
    central.buffer,
    central.byteOffset,
    central.byteLength,
  );

  const decoder = new TextDecoder("utf-8");
  let offset = 0;

  while (offset + 46 <= central.length) {
    if (centralView.getUint32(offset, true) !== 0x02014b50) break;

    const compressionMethod = centralView.getUint16(offset + 10, true);
    const compressedSize = centralView.getUint32(offset + 20, true);
    const uncompressedSize = centralView.getUint32(offset + 24, true);
    const fileNameLength = centralView.getUint16(offset + 28, true);
    const extraLength = centralView.getUint16(offset + 30, true);
    const commentLength = centralView.getUint16(offset + 32, true);
    const localHeaderOffset = centralView.getUint32(offset + 42, true);

    const name = decoder.decode(
      central.slice(offset + 46, offset + 46 + fileNameLength),
    );

    if (name === targetName) {
      const localHeader = new Uint8Array(
        await file
          .slice(localHeaderOffset, localHeaderOffset + 30)
          .arrayBuffer(),
      );

      const localView = new DataView(
        localHeader.buffer,
        localHeader.byteOffset,
        localHeader.byteLength,
      );

      if (localView.getUint32(0, true) !== 0x04034b50) {
        throw new Error("Cabeçalho interno inválido no ficheiro ODS.");
      }

      const localFileNameLength = localView.getUint16(26, true);
      const localExtraLength = localView.getUint16(28, true);

      return {
        compressionMethod,
        compressedSize,
        uncompressedSize,
        dataOffset:
          localHeaderOffset +
          30 +
          localFileNameLength +
          localExtraLength,
      };
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  throw new Error("Não encontrei content.xml dentro do ficheiro ODS.");
}

async function getOdsContentStream(file) {
  const entry = await findZipEntry(file, "content.xml");

  const compressedBlob = file.slice(
    entry.dataOffset,
    entry.dataOffset + entry.compressedSize,
  );

  let stream = compressedBlob.stream();

  if (entry.compressionMethod === 8) {
    if (typeof DecompressionStream !== "function") {
      throw new Error(
        "Este navegador não suporta o modo seguro para ficheiros ODS grandes. Usa uma versão recente do Chrome ou Edge.",
      );
    }

    stream = stream.pipeThrough(
      new DecompressionStream("deflate-raw"),
    );
  } else if (entry.compressionMethod !== 0) {
    throw new Error(
      `Compressão ODS não suportada (${entry.compressionMethod}).`,
    );
  }

  return {
    stream,
    uncompressedSize: Number(entry.uncompressedSize || 0),
  };
}

async function scanOdsArticles(
  file,
  {
    onHeader,
    onRow,
    onProgress,
  } = {},
) {
  const { stream, uncompressedSize } = await getOdsContentStream(file);
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");

  let buffer = "";
  let bytesRead = 0;
  let headerFound = false;
  let sourceColumns = [];
  let columns = null;
  let dataRows = 0;
  let lastYieldRow = 0;

  const articleAliases = aliasesFor("artigo");
  const rowCloseTag = "</table:table-row>";

  async function consumeRows() {
    while (true) {
      const start = buffer.indexOf("<table:table-row");

      if (start < 0) {
        // Keep only a tiny suffix so a split opening tag survives the next chunk.
        if (buffer.length > 1024) buffer = buffer.slice(-1024);
        return;
      }

      if (start > 0) buffer = buffer.slice(start);

      const end = buffer.indexOf(rowCloseTag);

      if (end < 0) return;

      const rowXml = buffer.slice(0, end + rowCloseTag.length);
      buffer = buffer.slice(end + rowCloseTag.length);

      const values = parseOdsRowXml(rowXml);

      if (!headerFound) {
        const looksLikeHeader = values.some((value) =>
          articleAliases.has(normalizeHeader(value)),
        );

        if (!looksLikeHeader) continue;

        sourceColumns = values;
        columns = buildColumnMap(values);

        if (columns.artigo < 0) {
          throw new Error(
            "Não encontrei a coluna Artigo. Usa uma coluna Artigo, Código ou Nosso Código.",
          );
        }

        if (columns.pvp2 < 0) {
          throw new Error(
            "Não encontrei a coluna PVP2. Esta atualização só importa artigos com PVP2 preenchido.",
          );
        }

        headerFound = true;
        onHeader?.({
          sourceColumns: sourceColumns.filter(Boolean),
          columns,
        });

        continue;
      }

      const row = buildNormalizedRow(values, columns);

      if (!row) continue;

      dataRows += 1;

      if (dataRows > MAX_IMPORT_ROWS) {
        throw new Error(
          `O ficheiro ultrapassa o limite de ${MAX_IMPORT_ROWS.toLocaleString("pt-PT")} linhas de artigos.`,
        );
      }

      await onRow?.(row, dataRows);

      if (dataRows - lastYieldRow >= PARSE_YIELD_EVERY_ROWS) {
        lastYieldRow = dataRows;
        await sleep(0);
      }
    }
  }

  while (true) {
    const { done, value } = await reader.read();

    if (done) break;

    bytesRead += value.byteLength;
    buffer += decoder.decode(value, { stream: true });

    await consumeRows();

    onProgress?.({
      bytesRead,
      totalBytes: uncompressedSize,
      percent: uncompressedSize
        ? Math.min(99, Math.max(1, Math.round((bytesRead / uncompressedSize) * 100)))
        : 0,
      rows: dataRows,
    });
  }

  const decoderTail = decoder.decode();
  if (decoderTail) buffer += decoderTail;

  await consumeRows();

  if (!headerFound) {
    throw new Error(
      "Não encontrei a linha de cabeçalhos no ficheiro ODS.",
    );
  }

  onProgress?.({
    bytesRead,
    totalBytes: uncompressedSize,
    percent: 100,
    rows: dataRows,
  });

  return {
    sourceColumns: sourceColumns.filter(Boolean),
    columns,
    dataRows,
    uncompressedSize,
  };
}

async function inspectOdsFile(file, { onProgress } = {}) {
  const seen = new Set();
  let duplicatesRemoved = 0;
  let sourceColumns = [];
  let dataRows = 0;

  const meta = await scanOdsArticles(file, {
    onHeader: (header) => {
      sourceColumns = header.sourceColumns;
    },
    onRow: async (row, rowNumber) => {
      dataRows = rowNumber;

      if (seen.has(row.artigo)) {
        duplicatesRemoved += 1;
      } else {
        seen.add(row.artigo);
      }
    },
    onProgress: ({ percent, rows }) => {
      onProgress?.({
        phase: "parsing",
        percent,
        processed: rows,
        total: 0,
        unique: seen.size,
      });
    },
  });

  return {
    mode: "streaming-ods",
    rows: null,
    articleCount: seen.size,
    totalRows: dataRows,
    validRows: dataRows,
    duplicatesRemoved,
    sourceColumns,
    sheetName: "Folha ODS",
    uncompressedSize: meta.uncompressedSize,
    maxImportRows: MAX_IMPORT_ROWS,
  };
}

/* =========================================================
   XLSX / XLS — legacy parser for smaller files
   ========================================================= */

function getCellDisplayValue(sheet, row, column) {
  const address = XLSX.utils.encode_cell({ r: row, c: column });
  const cell = sheet[address];

  if (!cell) return "";
  if (cell.w !== undefined && cell.w !== null) return clean(cell.w);
  return clean(cell.v);
}

function findHeaderRow(sheet, range) {
  const articleAliases = aliasesFor("artigo");
  const maxRow = Math.min(range.e.r, range.s.r + 30);

  for (let row = range.s.r; row <= maxRow; row += 1) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const value = normalizeHeader(
        getCellDisplayValue(sheet, row, column),
      );

      if (articleAliases.has(value)) return row;
    }
  }

  return range.s.r;
}

async function parseWorkbookFile(file, { onProgress } = {}) {
  onProgress?.({
    phase: "reading",
    percent: 1,
    processed: 0,
    total: 0,
  });

  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, {
    type: "array",
    cellDates: false,
    raw: false,
  });

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  if (!sheet || !sheet["!ref"]) {
    throw new Error("O ficheiro não contém uma folha válida.");
  }

  const range = XLSX.utils.decode_range(sheet["!ref"]);

  if (range.e.r - range.s.r > 120_000) {
    throw new Error(
      "Para ficheiros acima de 120.000 linhas usa ODS. O modo ODS é processado em streaming e não bloqueia o PromoPilot.",
    );
  }

  const headerRow = findHeaderRow(sheet, range);
  const sourceColumns = [];

  for (let column = range.s.c; column <= range.e.c; column += 1) {
    sourceColumns.push(
      getCellDisplayValue(sheet, headerRow, column),
    );
  }

  const relativeColumns = buildColumnMap(sourceColumns);

  if (relativeColumns.artigo < 0) {
    throw new Error(
      "Não encontrei a coluna Artigo. Usa uma coluna Artigo, Código ou Nosso Código.",
    );
  }

  if (relativeColumns.pvp2 < 0) {
    throw new Error(
      "Não encontrei a coluna PVP2. Esta atualização só importa artigos com PVP2 preenchido.",
    );
  }

  const columns = {};

  for (const [field, relativeIndex] of Object.entries(relativeColumns)) {
    columns[field] =
      relativeIndex >= 0 ? range.s.c + relativeIndex : -1;
  }

  const dataStartRow = headerRow + 1;
  const candidateRows = Math.max(
    0,
    range.e.r - dataStartRow + 1,
  );

  const unique = new Map();
  let validRows = 0;

  for (
    let rowIndex = dataStartRow;
    rowIndex <= range.e.r;
    rowIndex += 1
  ) {
    const values = [];

    for (
      let column = range.s.c;
      column <= Math.min(range.e.c, range.s.c + 63);
      column += 1
    ) {
      values[column - range.s.c] = getCellDisplayValue(
        sheet,
        rowIndex,
        column,
      );
    }

    // Convert absolute worksheet columns back to relative indexes.
    const rowColumns = {};

    for (const [field, absolute] of Object.entries(columns)) {
      rowColumns[field] =
        absolute >= 0 ? absolute - range.s.c : -1;
    }

    const row = buildNormalizedRow(values, rowColumns);

    if (row) {
      validRows += 1;
      unique.set(row.artigo, row);

      if (unique.size > MAX_IMPORT_ROWS) {
        throw new Error(
          `O ficheiro ultrapassa o limite de ${MAX_IMPORT_ROWS.toLocaleString("pt-PT")} artigos.`,
        );
      }
    }

    const processed = rowIndex - dataStartRow + 1;

    if (
      processed === candidateRows ||
      processed % PARSE_YIELD_EVERY_ROWS === 0
    ) {
      onProgress?.({
        phase: "parsing",
        percent: Math.max(
          1,
          Math.min(
            99,
            Math.round((processed / candidateRows) * 100),
          ),
        ),
        processed,
        total: candidateRows,
        unique: unique.size,
      });

      await sleep(0);
    }
  }

  const rows = [...unique.values()];

  onProgress?.({
    phase: "ready",
    percent: 100,
    processed: candidateRows,
    total: candidateRows,
    unique: rows.length,
  });

  return {
    mode: "memory-workbook",
    rows,
    articleCount: rows.length,
    sourceColumns: sourceColumns.filter(Boolean),
    sheetName,
    totalRows: candidateRows,
    validRows,
    duplicatesRemoved: Math.max(0, validRows - rows.length),
    maxImportRows: MAX_IMPORT_ROWS,
  };
}

export async function parseArticleDatabaseFile(
  file,
  { onProgress } = {},
) {
  if (!file) throw new Error("Seleciona um ficheiro.");

  const extension = String(file.name || "")
    .split(".")
    .pop()
    .toLowerCase();

  if (!["ods", "xlsx", "xls"].includes(extension)) {
    throw new Error(
      "Formato não suportado. Usa ODS, XLSX ou XLS.",
    );
  }

  if (extension === "ods") {
    onProgress?.({
      phase: "reading",
      percent: 1,
      processed: 0,
      total: 0,
    });

    return inspectOdsFile(file, { onProgress });
  }

  return parseWorkbookFile(file, { onProgress });
}

async function sendBatch({
  syncId,
  batchIndex,
  rows,
  aggregate,
  total,
  onProgress,
  onRetry,
}) {
  const result = await api(
    "/api/admin/articles/database-sync/batch",
    {
      method: "POST",
      body: JSON.stringify({
        syncId,
        batchIndex,
        rows,
      }),
    },
    {
      maxRetries: MAX_BATCH_RETRIES,
      onRetry: (retryInfo) => {
        onRetry?.({
          ...retryInfo,
          batchIndex,
          processed: aggregate.processed,
          total,
        });
      },
    },
  );

  const serverAggregate = aggregateFromTotals(
    result.totals,
    null,
  );

  const nextAggregate = serverAggregate || {
    processed: aggregate.processed + (result.processed || 0),
    updated: aggregate.updated + (result.updated || 0),
    inserted: aggregate.inserted + (result.inserted || 0),
    unchanged: aggregate.unchanged + (result.unchanged || 0),
    changedFields: {
      pvp1:
        aggregate.changedFields.pvp1 +
        (result.changedFields?.pvp1 || 0),
      pvp2:
        aggregate.changedFields.pvp2 +
        (result.changedFields?.pvp2 || 0),
      pvp3:
        aggregate.changedFields.pvp3 +
        (result.changedFields?.pvp3 || 0),
      estado:
        aggregate.changedFields.estado +
        (result.changedFields?.estado || 0),
    },
  };

  onProgress?.({
    processed: nextAggregate.processed,
    total,
    aggregate: nextAggregate,
    batchIndex,
    batchCount: Math.ceil(total / BATCH_SIZE),
  });

  return nextAggregate;
}

async function syncStreamingOds({
  file,
  parsed,
  syncId,
  aggregate,
  onProgress,
  onRetry,
}) {
  let batchRows = [];
  let batchIndex = 0;
  let currentAggregate = aggregate;

  await scanOdsArticles(file, {
    onRow: async (row) => {
      batchRows.push(row);

      if (batchRows.length < BATCH_SIZE) return;

      currentAggregate = await sendBatch({
        syncId,
        batchIndex,
        rows: batchRows,
        aggregate: currentAggregate,
        total: parsed.validRows,
        onProgress,
        onRetry,
      });

      batchRows = [];
      batchIndex += 1;

      await sleep(BATCH_DELAY_MS);
    },
  });

  if (batchRows.length) {
    currentAggregate = await sendBatch({
      syncId,
      batchIndex,
      rows: batchRows,
      aggregate: currentAggregate,
      total: parsed.validRows,
      onProgress,
      onRetry,
    });
  }

  return currentAggregate;
}

async function syncMemoryRows({
  parsed,
  syncId,
  aggregate,
  onProgress,
  onRetry,
}) {
  let currentAggregate = aggregate;
  let batchIndex = 0;

  for (
    let offset = 0;
    offset < parsed.rows.length;
    offset += BATCH_SIZE
  ) {
    const rows = parsed.rows.slice(
      offset,
      offset + BATCH_SIZE,
    );

    currentAggregate = await sendBatch({
      syncId,
      batchIndex,
      rows,
      aggregate: currentAggregate,
      total: parsed.rows.length,
      onProgress,
      onRetry,
    });

    batchIndex += 1;

    if (offset + BATCH_SIZE < parsed.rows.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return currentAggregate;
}

export async function syncArticleDatabase({
  file,
  parsed: preparedParsed = null,
  onProgress,
  onRetry,
}) {
  const parsed =
    preparedParsed ||
    (await parseArticleDatabaseFile(file));

  const totalRows =
    parsed.mode === "streaming-ods"
      ? Number(parsed.validRows || 0)
      : Number(parsed.rows?.length || 0);

  if (!totalRows) {
    throw new Error("Não existem artigos válidos para sincronizar.");
  }

  if (totalRows > MAX_IMPORT_ROWS) {
    throw new Error(
      `A sincronização suporta até ${MAX_IMPORT_ROWS.toLocaleString("pt-PT")} linhas de artigos por ficheiro.`,
    );
  }

  const start = await api(
    "/api/admin/articles/database-sync/start",
    {
      method: "POST",
      body: JSON.stringify({
        fileName: file.name,
        totalRows,
        columns: parsed.sourceColumns,
      }),
    },
  );

  const syncId = start.syncId;

  let aggregate = {
    processed: 0,
    updated: 0,
    inserted: 0,
    unchanged: 0,
    changedFields: {
      pvp1: 0,
      pvp2: 0,
      pvp3: 0,
      estado: 0,
    },
  };

  try {
    if (parsed.mode === "streaming-ods") {
      aggregate = await syncStreamingOds({
        file,
        parsed,
        syncId,
        aggregate,
        onProgress,
        onRetry,
      });
    } else {
      aggregate = await syncMemoryRows({
        parsed,
        syncId,
        aggregate,
        onProgress,
        onRetry,
      });
    }

    const finished = await api(
      "/api/admin/articles/database-sync/finish",
      {
        method: "POST",
        body: JSON.stringify({
          syncId,
          status: "completed",
        }),
      },
      {
        maxRetries: MAX_FINISH_RETRIES,
        onRetry,
      },
    );

    return {
      parsed,
      aggregate,
      item: finished.item,
    };
  } catch (error) {
    try {
      await api(
        "/api/admin/articles/database-sync/finish",
        {
          method: "POST",
          body: JSON.stringify({
            syncId,
            status: "failed",
            errorMessage:
              error?.message || "Erro desconhecido",
          }),
        },
        { maxRetries: 2 },
      );
    } catch {
      // Preserve original error.
    }

    throw error;
  }
}

export async function fetchArticleDatabaseSyncHistory() {
  const data = await api(
    "/api/admin/articles/database-sync/history?limit=8",
  );

  return Array.isArray(data.items) ? data.items : [];
}

export {
  BATCH_SIZE as ARTICLE_DATABASE_SYNC_BATCH_SIZE,
  MAX_IMPORT_ROWS as ARTICLE_DATABASE_SYNC_MAX_ROWS,
};
