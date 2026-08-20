"use client";

/* eslint-disable @next/next/no-img-element */

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes } from "../lib/image-optimizer";
import {
  VectorizeResult,
  vectorizePng,
} from "../lib/png-vectorizer";
import SvgCurveEditor from "./SvgCurveEditor";

type SourcePreview = {
  file: File;
  url: string;
  width: number;
  height: number;
};

const CONSTRUCTION_LABELS: Record<VectorizeResult["constructionKind"], string> = {
  "line-icon": "Линейная",
  "outline-icon": "Контурная",
  "filled-shape": "Заливка",
  multicolor: "Многоцветная",
};

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function resultVerdict(result: VectorizeResult) {
  const difference = result.sourceSize - result.svgSize;
  const percent = Math.round(Math.abs(difference) / result.sourceSize * 100);
  if (difference > 0) return { good: true, label: `SVG легче на ${percent}%` };
  if (difference < 0) return { good: false, label: `SVG тяжелее на ${percent}%` };
  return { good: true, label: "Вес почти не изменился" };
}

function similarityVerdict(result: VectorizeResult) {
  if (result.similarity >= result.qualityTarget) return "Высокое совпадение";
  if (result.similarity >= 0.92) return "Хорошее совпадение";
  return "Лучший найденный вариант";
}

export default function PngToSvgConverter() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<SourcePreview | null>(null);
  const [dragging, setDragging] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VectorizeResult | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const resultUrl = useMemo(
    () => result ? URL.createObjectURL(result.svgBlob) : null,
    [result],
  );
  const verdict = result ? resultVerdict(result) : null;
  const similarityPercent = result ? (result.similarity * 100).toFixed(1) : null;
  const geometryPercent = result ? Math.round(result.geometryScore * 100) : null;

  useEffect(() => {
    return () => {
      if (source) URL.revokeObjectURL(source.url);
    };
  }, [source]);

  useEffect(() => {
    return () => {
      if (resultUrl) URL.revokeObjectURL(resultUrl);
    };
  }, [resultUrl]);

  async function acceptFile(file: File) {
    setError(null);
    if (file.type !== "image/png" && !file.name.toLowerCase().endsWith(".png")) {
      setError("Загрузите PNG. Для фотографий используйте оптимизатор фото.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("PNG больше 10 МБ. Уменьшите исходник перед трассировкой.");
      return;
    }
    let previewUrl: string | null = null;
    try {
      previewUrl = URL.createObjectURL(file);
      const image = new Image();
      image.decoding = "async";
      image.src = previewUrl;
      await image.decode();
      setSource({
        file,
        url: previewUrl,
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
      setResult(null);
      setEditorOpen(false);
    } catch {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setError("Браузер не смог открыть этот PNG.");
    }
  }

  async function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) await acceptFile(file);
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void acceptFile(file);
  }

  async function runVectorization() {
    if (!source || working) return;
    setWorking(true);
    setError(null);
    setEditorOpen(false);
    try {
      const nextResult = await vectorizePng(source.file, {
        colors: 12,
        detail: "precise",
        removeSpecks: true,
        preset: "auto",
      });
      setResult(nextResult);
      window.setTimeout(() => {
        document.getElementById("svg-result")?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 80);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Не удалось создать SVG.");
    } finally {
      setWorking(false);
    }
  }

  if (editorOpen && result && source) {
    return (
      <SvgCurveEditor
        svg={result.svg}
        sourceUrl={source.url}
        fileName={result.fileName}
        onClose={() => setEditorOpen(false)}
      />
    );
  }

  return (
    <div className={`vectorizer-shell ${result ? "has-results" : ""}`}>
      <div className="optimizer-topline">
        <span>PNG → SVG · Smooth Reconstruction Engine</span>
        <span className="local-badge"><i /> Файл не загружается на сервер</span>
      </div>

      {!source ? (
        <div className="vector-upload-panel">
          <label
            className={`dropzone vector-dropzone ${dragging ? "is-dragging" : ""}`}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            <input
              ref={inputRef}
              className="visually-hidden"
              type="file"
              accept="image/png"
              onChange={handleFileInput}
            />
            <span className="upload-icon vector-upload-icon" aria-hidden="true"><span>◇</span></span>
            <strong>Перетащите PNG-иконку</strong>
            <p>или нажмите, чтобы выбрать файл</p>
            <button type="button" onClick={() => inputRef.current?.click()}>Выбрать PNG</button>
            <small>PNG до 10 МБ · прозрачность сохраняется</small>
          </label>
          <div className="vector-suitability-note">
            <strong>Новый режим</strong>
            <span>Сервис распознаёт прямые, окружности, углы и скругления, а затем подгоняет чистую конструкцию по исходному PNG.</span>
          </div>
          {error ? <p className="error-message">{error}</p> : null}
        </div>
      ) : (
        <div className="vectorizer-workspace">
          <section className="vector-settings" aria-label="Настройки векторизации">
            <div className="source-row vector-source-row">
              <img src={source.url} alt="Загруженный PNG" />
              <div>
                <strong>{source.file.name}</strong>
                <span>{source.width} × {source.height}px · {formatBytes(source.file.size)}</span>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Удалить изображение"
                onClick={() => { setSource(null); setResult(null); setError(null); }}
              >×</button>
            </div>
            {Math.max(source.width, source.height) < 512 ? (
              <p className="vector-resolution-note">Для точного восстановления геометрии лучше использовать PNG от 512 px.</p>
            ) : null}

            <div className="vector-auto-rebuild">
              <small>Полностью автоматический режим</small>
              <strong>Один готовый SVG — без выбора пресетов</strong>
              <p>Сервис сам определит конструкцию, проверит прямые и скругления, сравнит варианты на нескольких размерах и оставит только лучший результат.</p>
              <ul>
                <li>очистка альфа-канала и щербинок</li>
                <li>поиск осмысленной геометрии</li>
                <li>проверка линий в нескольких масштабах</li>
              </ul>
            </div>

            {error ? <p className="error-message">{error}</p> : null}
            <button className="vectorize-button" type="button" disabled={working} onClick={runVectorization}>
              {working ? <><i /> Ищем лучший вариант…</> : result ? "Проверить заново" : "Создать готовый SVG"}
            </button>
            <p className="vector-local-copy">Обработка проходит в вашем браузере. Исходник и результат нигде не сохраняются.</p>
          </section>

          <section className="vector-result" id="svg-result" aria-live="polite">
            {result && resultUrl ? (
              <>
                <header>
                  <span>
                    <small>Готовый вектор</small>
                    <strong>{result.fileName}</strong>
                    <i className="trace-kind-badge">{result.traceLabel}</i>
                  </span>
                  <em className={verdict?.good ? "is-good" : "is-warning"}>{verdict?.label}</em>
                </header>

                <div className="vector-preview-grid">
                  <article>
                    <span>Исходный PNG</span>
                    <div className="transparent-stage"><img src={source.url} alt="Исходный PNG" /></div>
                    <small>{formatBytes(result.sourceSize)}</small>
                  </article>
                  <article>
                    <span>Результат SVG</span>
                    <div className="transparent-stage"><img src={resultUrl} alt="Векторизованный SVG" /></div>
                    <small>{formatBytes(result.svgSize)}</small>
                  </article>
                </div>

                <div className="vector-quality-grid">
                  <div className={`vector-fidelity ${result.similarity >= result.qualityTarget ? "is-good" : "is-warning"}`}>
                    <div>
                      <span>
                        <small>Визуальное совпадение</small>
                        <strong>{similarityPercent}%</strong>
                      </span>
                      <em>{similarityVerdict(result)}</em>
                    </div>
                    <span className="vector-fidelity-track" aria-hidden="true">
                      <i style={{ width: `${Math.max(2, result.similarity * 100)}%` }} />
                    </span>
                    <p>SVG растрирован и наложен на PNG: проверяем силуэт, прозрачность и структуру.</p>
                  </div>
                  <div className={`vector-fidelity geometry-fidelity ${result.geometryScore >= 0.86 ? "is-good" : "is-warning"}`}>
                    <div>
                      <span>
                        <small>Чистота геометрии</small>
                        <strong>{geometryPercent}%</strong>
                      </span>
                      <em>{result.geometryScore >= 0.9 ? "Чистая конструкция" : "Точный черновик"}</em>
                    </div>
                    <span className="vector-fidelity-track" aria-hidden="true">
                      <i style={{ width: `${Math.max(2, result.geometryScore * 100)}%` }} />
                    </span>
                    <p>Распознано примитивов: {result.primitiveCount}. Штрафуем лишние узлы и дрожащие линии. Вариантов: {result.candidatesTested}.</p>
                  </div>
                </div>

                <div className="vector-result-stats">
                  <div><small>Вес SVG</small><strong>{formatBytes(result.svgSize)}</strong></div>
                  <div><small>Осмысленных узлов</small><strong>{result.nodeCount}</strong></div>
                  <div><small>Черновик → итог</small><strong>{result.draftNodeCount} → {result.nodeCount}</strong></div>
                  <div><small>Конструкция</small><strong>{CONSTRUCTION_LABELS[result.constructionKind]}</strong></div>
                </div>

                {result.similarity < result.qualityTarget ? (
                  <p className="vector-result-warning">
                    Совпадение ниже целевых {Math.round(result.qualityTarget * 100)}%. Сервис уже выбрал лучший автоматический вариант; для более точного восстановления загрузите исходник от 512 px.
                  </p>
                ) : null}

                {result.svgSize > result.sourceSize ? (
                  <p className="vector-result-warning">
                    Этот SVG тяжелее PNG. Для фотографий и сложных многоцветных изображений векторизация обычно не подходит.
                  </p>
                ) : null}

                <div className="vector-result-actions">
                  <button type="button" onClick={() => downloadBlob(result.svgBlob, result.fileName)}>Скачать SVG <span>↓</span></button>
                  <button type="button" onClick={() => setEditorOpen(true)}>Открыть в редакторе <span>↗</span></button>
                </div>
                <p>В редакторе PNG останется подложкой, а в скачанный SVG попадёт только чистый вектор.</p>
              </>
            ) : (
              <div className="vector-result-empty">
                <span aria-hidden="true">◇</span>
                <strong>Здесь появится чистая конструкция</strong>
                <p>Определим тип графики, построим геометрию и проверим её по исходному PNG.</p>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
