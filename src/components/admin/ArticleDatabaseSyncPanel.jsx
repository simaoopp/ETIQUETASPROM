import React, { useEffect, useRef, useState } from "react";
import {
  ARTICLE_DATABASE_SYNC_MAX_ROWS,
  fetchArticleDatabaseSyncHistory,
  parseArticleDatabaseFile,
  syncArticleDatabase,
} from "../../services/articleDatabaseSyncService";

const OWNER_EMAIL = "simao.pereira@susiarte.com";

function formatDate(value) {
  if (!value) return "—";

  try {
    return new Intl.DateTimeFormat("pt-PT", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("pt-PT");
}

export default function ArticleDatabaseSyncPanel({
  user,
  open,
  onClose,
}) {
  const inputRef = useRef(null);

  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressDetail, setProgressDetail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [history, setHistory] = useState([]);

  const busy = preparing || loading;
  const isOwner =
    String(user?.email || "").trim().toLowerCase() === OWNER_EMAIL;

  async function loadHistory() {
    try {
      setHistory(await fetchArticleDatabaseSyncHistory());
    } catch (historyError) {
      console.warn(historyError);
    }
  }

  useEffect(() => {
    if (open && isOwner) loadHistory();
  }, [open, isOwner]);

  if (!open || !isOwner) return null;

  async function chooseFile(nextFile) {
    setError("");
    setMessage("");
    setResult(null);
    setParsed(null);
    setProgress(0);
    setProgressDetail("");
    setConfirming(false);

    if (!nextFile) return;

    setFile(nextFile);
    setPreparing(true);
    setMessage("A analisar o ficheiro…");

    try {
      const data = await parseArticleDatabaseFile(nextFile, {
        onProgress: ({ phase, percent, processed, total, unique }) => {
          if (phase === "reading") {
            setProgress(1);
            setProgressDetail("A carregar o ficheiro para memória…");
            return;
          }

          if (phase === "parsing") {
            setProgress(percent);
            setProgressDetail(
              `${formatNumber(processed)} / ${formatNumber(total)} linhas · ${formatNumber(unique)} artigos únicos`,
            );
          }
        },
      });

      setParsed(data);
      setProgress(100);
      setProgressDetail(
        `${formatNumber(data.rows.length)} artigos únicos preparados`,
      );

      const duplicateText = data.duplicatesRemoved
        ? ` · ${formatNumber(data.duplicatesRemoved)} duplicados consolidados`
        : "";

      setMessage(
        `${formatNumber(data.rows.length)} artigos preparados para sincronização${duplicateText}.`,
      );
    } catch (parseError) {
      setFile(null);
      setParsed(null);
      setProgress(0);
      setProgressDetail("");
      setError(
        parseError?.message ||
        "Não foi possível ler o ficheiro.",
      );
    } finally {
      setPreparing(false);
    }
  }

  async function handleSync() {
    if (!file || !parsed || busy) return;

    if (!confirming) {
      setConfirming(true);
      setMessage(
        `Confirma a atualização de ${formatNumber(parsed.rows.length)} artigos. Os existentes só terão PVP1, PVP2, PVP3 e estado alterados.`,
      );
      return;
    }

    setLoading(true);
    setConfirming(false);
    setError("");
    setMessage("A sincronizar a base de dados…");
    setProgress(0);
    setProgressDetail(
      `0 / ${formatNumber(parsed.rows.length)} artigos`,
    );

    try {
      const data = await syncArticleDatabase({
        file,
        parsed,
        onProgress: ({
          processed,
          total,
          batchIndex,
          batchCount,
        }) => {
          setProgress(
            Math.min(100, Math.round((processed / total) * 100)),
          );

          setProgressDetail(
            `${formatNumber(processed)} / ${formatNumber(total)} artigos · lote ${formatNumber(batchIndex + 1)} / ${formatNumber(batchCount)}`,
          );

          setMessage("A atualizar o Supabase…");
        },
        onRetry: ({
          attempt,
          maxRetries,
          delayMs,
          processed,
          total,
        }) => {
          const seconds = Math.max(1, Math.ceil(Number(delayMs || 0) / 1000));

          setMessage(
            `Ligação temporariamente ocupada. Nova tentativa ${attempt}/${maxRetries} dentro de ${seconds}s…`,
          );

          if (Number.isFinite(processed) && Number.isFinite(total)) {
            setProgressDetail(
              `${formatNumber(processed)} / ${formatNumber(total)} artigos já confirmados`,
            );
          }
        },
      });

      setProgress(100);
      setProgressDetail(
        `${formatNumber(data.aggregate.processed)} artigos processados`,
      );
      setResult(data.aggregate);
      setMessage("Atualização concluída com sucesso.");
      await loadHistory();
    } catch (syncError) {
      setError(syncError?.message || "A sincronização falhou.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="admin-db-overlay"
      role="presentation"
      onMouseDown={(event) =>
        event.target === event.currentTarget &&
        !busy &&
        onClose()
      }
    >
      <section
        className="admin-db-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-db-title"
      >
        <div className="admin-db-header">
          <div>
            <span className="admin-db-eyebrow">Gestão de dados</span>
            <h2 id="admin-db-title">Atualizar base de artigos</h2>
            <p>
              Importa até {formatNumber(ARTICLE_DATABASE_SYNC_MAX_ROWS)} artigos
              e sincroniza preços, estado e novos artigos.
            </p>
          </div>

          <button
            type="button"
            className="admin-db-close"
            onClick={onClose}
            disabled={busy}
          >
            ×
          </button>
        </div>

        <div
          className="admin-db-dropzone"
          onClick={() => !busy && inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);

            if (!busy) {
              chooseFile(event.dataTransfer.files?.[0]);
            }
          }}
          data-dragging={dragging}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".ods,.xlsx,.xls"
            hidden
            onChange={(event) =>
              chooseFile(event.target.files?.[0])
            }
          />

          <strong>
            {file ? file.name : "Seleciona a tabela de artigos"}
          </strong>

          <span>
            {file
              ? busy
                ? "A processar o ficheiro…"
                : "Clica para escolher outro ficheiro"
              : "Arrasta aqui ou clica para procurar · ODS, XLSX ou XLS"}
          </span>
        </div>

        {parsed && (
          <div className="admin-db-summary">
            <div>
              <span>Artigos</span>
              <strong>{formatNumber(parsed.rows.length)}</strong>
            </div>
            <div>
              <span>Folha</span>
              <strong>{parsed.sheetName}</strong>
            </div>
            <div>
              <span>Duplicados</span>
              <strong>{formatNumber(parsed.duplicatesRemoved)}</strong>
            </div>
          </div>
        )}

        {busy && (
          <div className="admin-db-progress">
            <div className="admin-db-progress-top">
              <span>
                {preparing
                  ? "A preparar ficheiro"
                  : "A atualizar Supabase"}
              </span>
              <strong>{progress}%</strong>
            </div>

            <div className="admin-db-progress-track">
              <span style={{ width: `${progress}%` }} />
            </div>

            {progressDetail && (
              <small>{progressDetail}</small>
            )}
          </div>
        )}

        {message && (
          <div className="admin-db-message">{message}</div>
        )}

        {error && (
          <div className="admin-db-error">{error}</div>
        )}

        {result && (
          <div className="admin-db-result">
            <strong>Resultado</strong>

            <div className="admin-db-result-grid">
              <span>
                <b>{formatNumber(result.updated)}</b> alterados
              </span>
              <span>
                <b>{formatNumber(result.inserted)}</b> novos
              </span>
              <span>
                <b>{formatNumber(result.unchanged)}</b> iguais
              </span>
              <span>
                <b>
                  {formatNumber(
                    result.changedFields.pvp1 +
                    result.changedFields.pvp2 +
                    result.changedFields.pvp3,
                  )}
                </b>{" "}
                alterações de preço
              </span>
            </div>
          </div>
        )}

        <div className="admin-db-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setConfirming(false);
              onClose();
            }}
            disabled={busy}
          >
            Fechar
          </button>

          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSync}
            disabled={!parsed || busy}
          >
            {preparing
              ? "A preparar…"
              : loading
                ? "A atualizar…"
                : confirming
                  ? "Confirmar atualização"
                  : "Atualizar Base de Dados"}
          </button>
        </div>

        <div className="admin-db-history">
          <div className="admin-db-history-title">
            <strong>Últimas atualizações</strong>
            <button
              type="button"
              onClick={loadHistory}
              disabled={busy}
            >
              Atualizar
            </button>
          </div>

          {history.length ? (
            history.map((item) => {
              const total = Number(item.total_rows || 0);
              const processed = Number(item.processed_rows || 0);

              return (
                <div
                  className="admin-db-history-row"
                  key={item.id}
                >
                  <div>
                    <strong>{item.file_name}</strong>
                    <span>
                      {formatDate(item.created_at)}
                      {item.status === "processing" && total
                        ? ` · ${formatNumber(processed)} / ${formatNumber(total)}`
                        : ""}
                    </span>
                  </div>

                  <div>
                    <b>{formatNumber(item.updated_rows)}</b> alterados ·{" "}
                    <b>{formatNumber(item.inserted_rows)}</b> novos
                  </div>

                  <span
                    className={`admin-db-status admin-db-status-${item.status}`}
                  >
                    {item.status === "completed"
                      ? "Concluída"
                      : item.status === "processing"
                        ? "Em curso"
                        : item.status === "cancelled"
                          ? "Cancelada"
                          : "Falhou"}
                  </span>
                </div>
              );
            })
          ) : (
            <p>Sem sincronizações registadas.</p>
          )}
        </div>
      </section>
    </div>
  );
}
