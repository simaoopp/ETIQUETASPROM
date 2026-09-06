import * as XLSX from "xlsx";
import { supabase } from "../lib/supabase";

const API_BASE_URL = String(process.env.REACT_APP_API_BASE_URL || "").replace(/\/+$/, "");

// 300k-ready defaults.
// 300,000 / 250 = 1,200 HTTP batches.
const MAX_IMPORT_ROWS = 300_000;
const BATCH_SIZE = 250;
const BATCH_DELAY_MS = 60;
const MAX_BATCH_RETRIES = 6;
const MAX_FINISH_RETRIES = 4;
const PARSE_YIELD_EVERY_ROWS = 4_000;

const HEADER_ALIASES = {
  artigo: ["Artigo", "artigo_interno", "codigo", "código", "Nosso Codigo", "Nosso Código"],
  descricao: ["Descricao", "Descrição"],
  pvp1: ["PVP1", "PVP 1"],
  pvp2: ["PVP2", "PVP 2"],
  pvp3: ["PVP3", "PVP 3"],
  estado: ["Estado", "Status"],
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

function getCellDisplayValue(sheet, row, column) {
  const address = XLSX.utils.encode_cell({ r: row, c: column });
  const cell = sheet[address];
  if (!cell) return "";
  if (cell.w !== undefined && cell.w !== null) return clean(cell.w);
  return clean(cell.v);
}

function aliasesFor(field) {
  return new Set((HEADER_ALIASES[field] || []).map(normalizeHeader));
}

function findHeaderRow(sheet, range) {
  const articleAliases = aliasesFor("artigo");
  const maxRow = Math.min(range.e.r, range.s.r + 30);

  for (let row = range.s.r; row <= maxRow; row += 1) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const value = normalizeHeader(getCellDisplayValue(sheet, row, column));
      if (articleAliases.has(value)) return row;
    }
  }

  return range.s.r;
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

function mapSheetRow(sheet, rowIndex, columns) {
  const value = (field) => {
    const column = columns[field];
    if (!Number.isInteger(column) || column < 0) return "";
    return getCellDisplayValue(sheet, rowIndex, column);
  };

  return {
    artigo: clean(value("artigo")),
    descricao: clean(value("descricao")),
    pvp1: normalizePrice(value("pvp1")),
    pvp2: normalizePrice(value("pvp2")),
    pvp3: normalizePrice(value("pvp3")),
    estado: clean(value("estado")),
  };
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

function shouldRetryStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

async function api(path, options = {}, {
  maxRetries = 0,
  onRetry,
} = {}) {
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
      onRetry?.({
        attempt,
        maxRetries,
        delayMs,
        reason: "Falha de ligação",
      });
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

    if (!shouldRetryStatus(response.status) || attempt >= maxRetries) {
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

export async function parseArticleDatabaseFile(file, { onProgress } = {}) {
  if (!file) throw new Error("Seleciona um ficheiro.");

  const extension = String(file.name || "").split(".").pop().toLowerCase();
  if (!["ods", "xlsx", "xls"].includes(extension)) {
    throw new Error("Formato não suportado. Usa ODS, XLSX ou XLS.");
  }

  onProgress?.({ phase: "reading", percent: 1, processed: 0, total: 0 });

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
  const headerRow = findHeaderRow(sheet, range);

  const sourceColumns = [];
  for (let column = range.s.c; column <= range.e.c; column += 1) {
    sourceColumns.push(getCellDisplayValue(sheet, headerRow, column));
  }

  const relativeColumns = buildColumnMap(sourceColumns);
  if (relativeColumns.artigo < 0) {
    throw new Error(
      "Não encontrei a coluna Artigo. Usa uma coluna Artigo, Código ou Nosso Código.",
    );
  }

  // Convert relative indexes (inside sourceColumns) to actual worksheet columns.
  const columns = {};
  for (const [field, relativeIndex] of Object.entries(relativeColumns)) {
    columns[field] = relativeIndex >= 0 ? range.s.c + relativeIndex : -1;
  }

  const dataStartRow = headerRow + 1;
  const candidateRows = Math.max(0, range.e.r - dataStartRow + 1);
  if (!candidateRows) {
    throw new Error("O ficheiro não contém linhas de artigos.");
  }

  // One Map only: avoids rawRows + rows + unique all existing simultaneously.
  // Last occurrence wins, preserving the updater's previous behaviour.
  const unique = new Map();
  let validRows = 0;

  for (let rowIndex = dataStartRow; rowIndex <= range.e.r; rowIndex += 1) {
    const row = mapSheetRow(sheet, rowIndex, columns);

    if (row.artigo) {
      validRows += 1;
      unique.set(row.artigo, row);

      if (unique.size > MAX_IMPORT_ROWS) {
        throw new Error(
          `O ficheiro ultrapassa o limite desta versão: ${MAX_IMPORT_ROWS.toLocaleString("pt-PT")} artigos únicos.`,
        );
      }
    }

    const processed = rowIndex - dataStartRow + 1;
    if (
      processed === candidateRows ||
      processed % PARSE_YIELD_EVERY_ROWS === 0
    ) {
      const percent = Math.max(
        1,
        Math.min(99, Math.round((processed / candidateRows) * 100)),
      );

      onProgress?.({
        phase: "parsing",
        percent,
        processed,
        total: candidateRows,
        unique: unique.size,
      });

      // Yield so a 300k-row file does not freeze the page for the entire loop.
      await sleep(0);
    }
  }

  if (!unique.size) {
    throw new Error("Não existem artigos válidos no ficheiro.");
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
    rows,
    sourceColumns: sourceColumns.filter(Boolean),
    sheetName,
    totalRows: candidateRows,
    validRows,
    duplicatesRemoved: Math.max(0, validRows - rows.length),
    maxImportRows: MAX_IMPORT_ROWS,
  };
}

export async function syncArticleDatabase({
  file,
  parsed: preparedParsed = null,
  onProgress,
  onRetry,
}) {
  // Important for 300k: the panel already parsed the file once.
  // Do not parse the whole workbook a second time.
  const parsed =
    preparedParsed ||
    await parseArticleDatabaseFile(file);

  if (parsed.rows.length > MAX_IMPORT_ROWS) {
    throw new Error(
      `A sincronização suporta até ${MAX_IMPORT_ROWS.toLocaleString("pt-PT")} artigos por ficheiro.`,
    );
  }

  // start is intentionally not retried automatically: creating a sync log is
  // not idempotent without a server-generated syncId.
  const start = await api("/api/admin/articles/database-sync/start", {
    method: "POST",
    body: JSON.stringify({
      fileName: file.name,
      totalRows: parsed.rows.length,
      columns: parsed.sourceColumns,
    }),
  });

  const syncId = start.syncId;

  let aggregate = {
    processed: 0,
    updated: 0,
    inserted: 0,
    unchanged: 0,
    changedFields: { pvp1: 0, pvp2: 0, pvp3: 0, estado: 0 },
  };

  try {
    let batchIndex = 0;

    for (let offset = 0; offset < parsed.rows.length; offset += BATCH_SIZE) {
      const rows = parsed.rows.slice(offset, offset + BATCH_SIZE);

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
              total: parsed.rows.length,
            });
          },
        },
      );

      const serverAggregate = aggregateFromTotals(result.totals, null);

      if (serverAggregate) {
        // Server totals are authoritative. This also makes a retry of an
        // already-committed batch safe and prevents double-counting.
        aggregate = serverAggregate;
      } else {
        aggregate.processed += result.processed || 0;
        aggregate.updated += result.updated || 0;
        aggregate.inserted += result.inserted || 0;
        aggregate.unchanged += result.unchanged || 0;

        for (const key of Object.keys(aggregate.changedFields)) {
          aggregate.changedFields[key] += result.changedFields?.[key] || 0;
        }
      }

      onProgress?.({
        processed: aggregate.processed,
        total: parsed.rows.length,
        aggregate,
        batchIndex,
        batchCount: Math.ceil(parsed.rows.length / BATCH_SIZE),
      });

      batchIndex += 1;

      if (offset + BATCH_SIZE < parsed.rows.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    const finished = await api(
      "/api/admin/articles/database-sync/finish",
      {
        method: "POST",
        body: JSON.stringify({ syncId, status: "completed" }),
      },
      {
        maxRetries: MAX_FINISH_RETRIES,
        onRetry,
      },
    );

    return { parsed, aggregate, item: finished.item };
  } catch (error) {
    try {
      await api(
        "/api/admin/articles/database-sync/finish",
        {
          method: "POST",
          body: JSON.stringify({
            syncId,
            status: "failed",
            errorMessage: error?.message || "Erro desconhecido",
          }),
        },
        { maxRetries: 2 },
      );
    } catch {
      // Preserve the original sync error.
    }

    throw error;
  }
}

export async function fetchArticleDatabaseSyncHistory() {
  const data = await api("/api/admin/articles/database-sync/history?limit=8");
  return Array.isArray(data.items) ? data.items : [];
}

export {
  BATCH_SIZE as ARTICLE_DATABASE_SYNC_BATCH_SIZE,
  MAX_IMPORT_ROWS as ARTICLE_DATABASE_SYNC_MAX_ROWS,
};
