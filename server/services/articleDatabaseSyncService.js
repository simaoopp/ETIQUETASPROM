import { supabaseAdminClient } from "../lib/supabaseClients.js";
import { AppError } from "../middleware/errorHandler.js";

const MAX_BATCH_SIZE = Number(process.env.ARTICLE_DB_SYNC_MAX_BATCH_SIZE || 300);
const DB_READ_CHUNK_SIZE = Number(process.env.ARTICLE_DB_SYNC_READ_CHUNK_SIZE || 80);
const DB_WRITE_CHUNK_SIZE = Number(process.env.ARTICLE_DB_SYNC_WRITE_CHUNK_SIZE || 40);
const DB_TIMEOUT_RETRIES = Math.max(
  0,
  Number(process.env.ARTICLE_DB_SYNC_TIMEOUT_RETRIES || 4),
);

const ARTICLE_COLUMNS = ["artigo", "descricao", "pvp1", "pvp2", "pvp3", "estado"];

function text(value) {
  return String(value ?? "").trim();
}

function normalizePrice(value) {
  const clean = text(value).replace(/[^\d,.-]/g, "");
  if (!clean || clean === "-") return null;

  const normalized = clean.includes(",")
    ? clean.replace(/\./g, "").replace(",", ".")
    : clean;

  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

function hasOwn(input, ...keys) {
  return keys.some((key) =>
    Object.prototype.hasOwnProperty.call(input || {}, key),
  );
}

function normalizeRow(input = {}) {
  const artigo = text(input.artigo || input.Artigo);

  const row = { artigo };

  if (hasOwn(input, "descricao", "Descricao", "Descrição")) {
    row.descricao = text(
      input.descricao ?? input.Descricao ?? input["Descrição"],
    );
  }

  if (hasOwn(input, "pvp1", "PVP1")) {
    row.pvp1 = text(input.pvp1 ?? input.PVP1);
  }

  if (hasOwn(input, "pvp2", "PVP2")) {
    row.pvp2 = normalizePrice(input.pvp2 ?? input.PVP2);
  }

  if (hasOwn(input, "pvp3", "PVP3")) {
    row.pvp3 = text(input.pvp3 ?? input.PVP3);
  }

  if (hasOwn(input, "estado", "Estado")) {
    row.estado = text(input.estado ?? input.Estado);
  }

  if (
    hasOwn(
      input,
      "codigoBarras",
      "codigo_barras",
      "Cód. Barras",
      "EAN",
    )
  ) {
    row.codigoBarras = text(
      input.codigoBarras ??
      input.codigo_barras ??
      input["Cód. Barras"] ??
      input.EAN,
    );
  }

  return row;
}

function buildSearchTerms(row) {
  return [row.artigo, row.descricao, row.codigoBarras]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function samePrice(a, b) {
  if (a === null || a === undefined || a === "") {
    return b === null || b === undefined || b === "";
  }

  const left = Number(a);
  const right = Number(b);

  if (Number.isFinite(left) && Number.isFinite(right)) {
    return left === right;
  }

  return text(a) === text(b);
}

function getChangedFields(next, current) {
  const changes = {};

  if (
    next.pvp1 !== undefined &&
    text(current.pvp1) !== next.pvp1
  ) {
    changes.pvp1 = true;
  }

  if (
    next.pvp2 !== undefined &&
    !samePrice(current.pvp2, next.pvp2)
  ) {
    changes.pvp2 = true;
  }

  if (
    next.pvp3 !== undefined &&
    text(current.pvp3) !== next.pvp3
  ) {
    changes.pvp3 = true;
  }

  if (
    next.estado !== undefined &&
    text(current.estado) !== next.estado
  ) {
    changes.estado = true;
  }

  return changes;
}

function requireClient() {
  if (!supabaseAdminClient) {
    throw new AppError(
      "SERVICE_UNAVAILABLE",
      "Serviço de base de dados indisponível.",
      { status: 503 },
    );
  }

  return supabaseAdminClient;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk(items, size) {
  const safeSize = Math.max(1, Number(size) || 1);
  const result = [];

  for (let index = 0; index < items.length; index += safeSize) {
    result.push(items.slice(index, index + safeSize));
  }

  return result;
}

function isStatementTimeout(error) {
  return (
    String(error?.code || "") === "57014" ||
    /statement timeout|canceling statement/i.test(String(error?.message || ""))
  );
}

async function runDbOperation(
  operation,
  {
    label = "database operation",
    retries = DB_TIMEOUT_RETRIES,
  } = {},
) {
  let attempt = 0;

  while (true) {
    const result = await operation();

    if (!result?.error) {
      return result;
    }

    if (!isStatementTimeout(result.error) || attempt >= retries) {
      throw result.error;
    }

    attempt += 1;

    console.warn(
      `[article-db-sync] ${label} timeout; retry ${attempt}/${retries}`,
      {
        code: result.error.code,
        message: result.error.message,
      },
    );

    await sleep(Math.min(250 * (2 ** (attempt - 1)), 2_500));
  }
}

async function fetchExistingArticles(client, codes) {
  const rows = [];

  for (const codeChunk of chunk(codes, DB_READ_CHUNK_SIZE)) {
    const result = await runDbOperation(
      () =>
        client
          .from("articles")
          .select("artigo,pvp1,pvp2,pvp3,estado")
          .in("artigo", codeChunk),
      { label: `read ${codeChunk.length} articles` },
    );

    rows.push(...(result.data || []));
  }

  return rows;
}

async function writeArticleUpdates(client, updates) {
  for (const updateChunk of chunk(updates, DB_WRITE_CHUNK_SIZE)) {
    await runDbOperation(
      () =>
        client
          .from("articles")
          .upsert(updateChunk, { onConflict: "artigo" }),
      { label: `update ${updateChunk.length} articles` },
    );
  }
}

async function writeArticleInserts(client, inserts) {
  for (const insertChunk of chunk(inserts, DB_WRITE_CHUNK_SIZE)) {
    await runDbOperation(
      () => client.from("articles").insert(insertChunk),
      { label: `insert ${insertChunk.length} articles` },
    );
  }
}

async function resolveOrganizationId({ req, client }) {
  if (req.organizationId) return req.organizationId;

  if (req.auth?.profile?.default_organization_id) {
    return req.auth.profile.default_organization_id;
  }

  const { data, error } = await client
    .from("profiles")
    .select("default_organization_id")
    .eq("id", req.authUser.id)
    .maybeSingle();

  if (error) throw error;
  if (data?.default_organization_id) return data.default_organization_id;

  const membership = await client
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", req.authUser.id)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (membership.error) throw membership.error;

  return membership.data?.organization_id || null;
}

function totalsFromLog(log = {}) {
  return {
    processed_rows: Number(log.processed_rows || 0),
    updated_rows: Number(log.updated_rows || 0),
    inserted_rows: Number(log.inserted_rows || 0),
    unchanged_rows: Number(log.unchanged_rows || 0),
    pvp1_changes: Number(log.pvp1_changes || 0),
    pvp2_changes: Number(log.pvp2_changes || 0),
    pvp3_changes: Number(log.pvp3_changes || 0),
    estado_changes: Number(log.estado_changes || 0),
  };
}

export async function startArticleDatabaseSync({
  req,
  fileName,
  totalRows,
  columns,
}) {
  const client = requireClient();
  const organizationId = await resolveOrganizationId({ req, client });

  if (!organizationId) {
    throw new AppError(
      "TENANT_REQUIRED",
      "Não foi possível determinar a organização da base de dados.",
    );
  }

  const safeTotalRows = Math.max(0, Number(totalRows) || 0);

  if (safeTotalRows > 300_000) {
    throw new AppError(
      "VALIDATION_ERROR",
      "A atualização suporta no máximo 300.000 artigos por ficheiro.",
    );
  }

  const { data, error } = await client
    .from("article_sync_logs")
    .insert({
      organization_id: organizationId,
      user_id: req.authUser.id,
      user_email: req.auth?.email || req.authUser.email || "",
      file_name: text(fileName).slice(0, 255),
      total_rows: safeTotalRows,
      columns: Array.isArray(columns)
        ? columns.map(text).filter(Boolean).slice(0, 100)
        : [],
      status: "processing",
      last_batch_index: -1,
    })
    .select("id,created_at")
    .single();

  if (error) throw error;

  return {
    syncId: data.id,
    organizationId,
    createdAt: data.created_at,
  };
}

export async function processArticleDatabaseSyncBatch({
  req,
  syncId,
  batchIndex,
  rows,
}) {
  const client = requireClient();

  const normalizedRows = (Array.isArray(rows) ? rows : [])
    .map(normalizeRow)
    .filter((row) => row.artigo);

  const safeBatchIndex = Number(batchIndex);

  if (!syncId || !normalizedRows.length) {
    throw new AppError("VALIDATION_ERROR", "Lote inválido ou vazio.");
  }

  if (!Number.isInteger(safeBatchIndex) || safeBatchIndex < 0) {
    throw new AppError("VALIDATION_ERROR", "Índice do lote inválido.");
  }

  if (normalizedRows.length > MAX_BATCH_SIZE) {
    throw new AppError(
      "VALIDATION_ERROR",
      `O lote não pode ultrapassar ${MAX_BATCH_SIZE} artigos.`,
    );
  }

  const { data: log, error: logError } = await client
    .from("article_sync_logs")
    .select(
      "id,organization_id,status,last_batch_index,processed_rows,updated_rows,inserted_rows,unchanged_rows,pvp1_changes,pvp2_changes,pvp3_changes,estado_changes",
    )
    .eq("id", syncId)
    .eq("user_id", req.authUser.id)
    .maybeSingle();

  if (logError) throw logError;
  if (!log) throw new AppError("NOT_FOUND", "Sincronização não encontrada.");

  if (log.status !== "processing") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Esta sincronização já terminou.",
    );
  }

  const lastBatchIndex = Number(log.last_batch_index ?? -1);

  // A response may be lost after the database commit. Retrying the same HTTP
  // batch must not apply it twice or double the counters.
  if (safeBatchIndex <= lastBatchIndex) {
    return {
      duplicate: true,
      processed: 0,
      updated: 0,
      inserted: 0,
      unchanged: 0,
      changedFields: { pvp1: 0, pvp2: 0, pvp3: 0, estado: 0 },
      totals: totalsFromLog(log),
    };
  }

  if (safeBatchIndex !== lastBatchIndex + 1) {
    throw new AppError(
      "BATCH_OUT_OF_ORDER",
      "Os lotes chegaram fora de ordem. Repete a sincronização a partir do lote atual.",
      {
        status: 409,
        details: {
          expectedBatchIndex: lastBatchIndex + 1,
          receivedBatchIndex: safeBatchIndex,
        },
      },
    );
  }

  const codes = [...new Set(normalizedRows.map((row) => row.artigo))];
  const existingData = await fetchExistingArticles(client, codes);
  const existing = new Map(existingData.map((row) => [row.artigo, row]));

  const updates = [];
  const inserts = [];
  const changedFields = { pvp1: 0, pvp2: 0, pvp3: 0, estado: 0 };
  let unchanged = 0;

  for (const row of normalizedRows) {
    const current = existing.get(row.artigo);

    if (current) {
      const changes = getChangedFields(row, current);

      if (!Object.keys(changes).length) {
        unchanged += 1;
        continue;
      }

      for (const field of Object.keys(changes)) {
        changedFields[field] += 1;
      }

      const update = {
        artigo: row.artigo,
      };

      for (const field of Object.keys(changes)) {
        update[field] = row[field];
      }

      updates.push(update);
    } else {
      inserts.push({
        artigo: row.artigo,
        descricao: row.descricao ?? "",
        pvp1: row.pvp1 ?? "",
        pvp2: row.pvp2 ?? null,
        pvp3: row.pvp3 ?? "",
        estado: row.estado ?? "",
        organization_id: log.organization_id,
        codigo_barras: row.codigoBarras ?? "",
        search_terms: buildSearchTerms(row),
      });
    }
  }

  if (updates.length) {
    await writeArticleUpdates(client, updates);
  }

  if (inserts.length) {
    await writeArticleInserts(client, inserts);
  }

  const nextTotals = {
    processed_rows: Number(log.processed_rows || 0) + normalizedRows.length,
    updated_rows: Number(log.updated_rows || 0) + updates.length,
    inserted_rows: Number(log.inserted_rows || 0) + inserts.length,
    unchanged_rows: Number(log.unchanged_rows || 0) + unchanged,
    pvp1_changes: Number(log.pvp1_changes || 0) + changedFields.pvp1,
    pvp2_changes: Number(log.pvp2_changes || 0) + changedFields.pvp2,
    pvp3_changes: Number(log.pvp3_changes || 0) + changedFields.pvp3,
    estado_changes: Number(log.estado_changes || 0) + changedFields.estado,
  };

  const { data: updatedLog, error: updateLogError } = await client
    .from("article_sync_logs")
    .update({
      ...nextTotals,
      last_batch_index: safeBatchIndex,
      last_batch_at: new Date().toISOString(),
    })
    .eq("id", syncId)
    .eq("user_id", req.authUser.id)
    .eq("last_batch_index", lastBatchIndex)
    .select(
      "last_batch_index,processed_rows,updated_rows,inserted_rows,unchanged_rows,pvp1_changes,pvp2_changes,pvp3_changes,estado_changes",
    )
    .maybeSingle();

  if (updateLogError) throw updateLogError;

  if (!updatedLog) {
    throw new AppError(
      "BATCH_CONFLICT",
      "O estado da sincronização mudou durante o processamento. Repete este lote.",
      { status: 409 },
    );
  }

  return {
    duplicate: false,
    processed: normalizedRows.length,
    updated: updates.length,
    inserted: inserts.length,
    unchanged,
    changedFields,
    totals: updatedLog,
  };
}

export async function finishArticleDatabaseSync({
  req,
  syncId,
  status = "completed",
  errorMessage = "",
}) {
  const client = requireClient();

  const safeStatus = ["completed", "failed", "cancelled"].includes(status)
    ? status
    : "completed";

  const { data, error } = await client
    .from("article_sync_logs")
    .update({
      status: safeStatus,
      finished_at: new Date().toISOString(),
      error_message: text(errorMessage).slice(0, 2000) || null,
    })
    .eq("id", syncId)
    .eq("user_id", req.authUser.id)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

export async function listArticleDatabaseSyncHistory({
  req,
  limit = 10,
}) {
  const client = requireClient();
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 30);

  const { data, error } = await client
    .from("article_sync_logs")
    .select(
      "id,file_name,status,total_rows,processed_rows,updated_rows,inserted_rows,unchanged_rows,pvp1_changes,pvp2_changes,pvp3_changes,estado_changes,last_batch_index,created_at,finished_at,error_message,user_email",
    )
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (error) throw error;

  return data || [];
}

export {
  ARTICLE_COLUMNS,
  MAX_BATCH_SIZE,
  DB_READ_CHUNK_SIZE,
  DB_WRITE_CHUNK_SIZE,
};
