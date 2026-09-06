import { AppError } from "../middleware/errorHandler.js";
import { adminActionRateLimit, articleDatabaseSyncRateLimit } from "../middleware/security.js";
import {
  finishArticleDatabaseSync,
  listArticleDatabaseSyncHistory,
  processArticleDatabaseSyncBatch,
  startArticleDatabaseSync,
} from "../services/articleDatabaseSyncService.js";

const OWNER_EMAIL = "simao.pereira@susiarte.com";

function requireDatabaseOwner(req, _res, next) {
  const email = String(req.auth?.email || req.authUser?.email || "").trim().toLowerCase();
  if (email !== OWNER_EMAIL) {
    return next(new AppError("FORBIDDEN", "Esta função está disponível apenas para o administrador autorizado."));
  }
  return next();
}

export function registerArticleDatabaseSyncRoutes(app, { requireAuth, attachTenantContext }) {
  const guard = [requireAuth, attachTenantContext, requireDatabaseOwner];

  app.get("/api/admin/articles/database-sync/history", ...guard, async (req, res, next) => {
    try {
      const items = await listArticleDatabaseSyncHistory({ req, limit: req.query?.limit });
      return res.json({ ok: true, items });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/admin/articles/database-sync/start", ...guard, adminActionRateLimit, async (req, res, next) => {
    try {
      const result = await startArticleDatabaseSync({
        req,
        fileName: req.body?.fileName,
        totalRows: req.body?.totalRows,
        columns: req.body?.columns,
      });
      return res.status(201).json({ ok: true, ...result });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/admin/articles/database-sync/batch", ...guard, articleDatabaseSyncRateLimit, async (req, res, next) => {
    try {
      const result = await processArticleDatabaseSyncBatch({
        req,
        syncId: req.body?.syncId,
        batchIndex: req.body?.batchIndex,
        rows: req.body?.rows,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/admin/articles/database-sync/finish", ...guard, async (req, res, next) => {
    try {
      const item = await finishArticleDatabaseSync({
        req,
        syncId: req.body?.syncId,
        status: req.body?.status,
        errorMessage: req.body?.errorMessage,
      });
      return res.json({ ok: true, item });
    } catch (error) {
      return next(error);
    }
  });
}
