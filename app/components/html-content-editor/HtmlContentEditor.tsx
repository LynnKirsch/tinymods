"use client";

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { detectAccordionGroups } from "../../lib/html-content-editor/accordion-groups";
import {
  buildAccordionContentItems,
  buildContentGroups,
  type AccordionContentItem,
  type ContentGroup,
} from "../../lib/html-content-editor/content-groups";
import { extractEditableEntitiesWithVideoStories } from "../../lib/html-content-editor/extract-editable-entities";
import {
  groupImageEntities,
  linkedVideoEntities,
  isVideoEntity,
  videoPosterEntity,
  type ImageGroup,
  isImageGroupEntity,
  isImageEntity,
  usesImageMetadata,
} from "../../lib/html-content-editor/image-groups";
import {
  byteSizeFromDataUrl,
  imageFormatFromSource,
  imageMetadataLine,
  type ImageMetadata,
} from "../../lib/html-content-editor/image-metadata";
import { validateRequiredImageValues } from "../../lib/html-content-editor/image-validation";
import {
  calculatePreviewScale,
  DEFAULT_PREVIEW_VIEWPORT_ID,
  PREVIEW_VIEWPORTS,
  previewViewportById,
} from "../../lib/html-content-editor/preview-viewport";
import {
  detectRepeatingGroups,
} from "../../lib/html-content-editor/repeating-structures";
import {
  detectSliderGroups,
  sliderActivationPath,
  type SlideGroup,
  type SliderGroup,
} from "../../lib/html-content-editor/slider-groups";
import { textLengthWarning } from "../../lib/html-content-editor/text-length";
import type {
  EditableEntity,
  ImageEntityKind,
} from "../../lib/html-content-editor/types";
import styles from "./HtmlContentEditor.module.css";


import { createBlockSource, createSourceFragment, editorEntityKey, reorderFragments, type BlockSource } from "../../lib/html-content-editor/block-source";
import { assembleBlock, blockHasInvalidContent, commitBlockEdits, editedBlockFragments, exportBlock, isBlockContentDirty } from "../../lib/html-content-editor/block-assembly";
import { compositeEditError } from "../../lib/html-content-editor/encode-source-value";
import { buildLivePreview } from "../../lib/html-content-editor/preview-runtime";
import { sendPreviewCommand, validatePreviewMessage, type PreviewCommand, type SliderPosition } from "../../lib/html-content-editor/preview-bridge";
function mediaTitleForEntities(entities: EditableEntity[]) {
  const titles = [...new Set(groupImageEntities(entities).map(group => group.title))]
    .filter(title => title === "Видео" || title === "Постер к видео");
  return titles.join(" / ") || "Медиа";
}

function fieldLabel(entity: EditableEntity) {
  if (entity.kind === "href" && entity.context.type === "attribute") {
    if (entity.context.linkRole === "button") return "Ссылка кнопки";
    if (entity.context.linkRole === "card") return "Ссылка карточки";
    return "Ссылка";
  }
  if (entity.kind === "poster" || (entity.context.type === "attribute" && entity.context.mediaRole === "video-poster")) return "Постер к видео";
  if (entity.kind === "src" && entity.context.type === "attribute" && entity.context.mediaRole === "video") {
    return "Ссылка на видео";
  }
  if (entity.kind === "src") return "Изображение";
  if (entity.kind === "srcset") return "Вариант изображения";
  if (entity.kind === "background-image") return "Фоновое изображение";
  if (entity.kind === "alt") return "ALT изображения";
  if (entity.kind === "text" && entity.context.type === "text") {
    if (entity.context.linkRole === "button") return "Кнопка";
    if (entity.context.linkRole === "card") return "Текст карточки";
    if (entity.context.linkRole === "link") return "Текст ссылки";
    if (/^h[1-6]$/.test(entity.context.tagName)) return "Заголовок";
    if (entity.context.tagName === "li") return "Пункт";
  }
  return "Текст";
}

function canPreviewImage(value: string) {
  return /^(https?:\/\/|data:image\/|\/|\.\/|\.\.\/)/i.test(value.trim());
}

function imageMetadataKey(value: string) {
  return value.trim();
}

function loadIntrinsicImageSize(source: string) {
  return new Promise<{ width?: number; height?: number }>((resolve) => {
    if (!canPreviewImage(source) || typeof Image === "undefined") {
      resolve({});
      return;
    }

    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({});
    image.src = source;
  });
}

async function loadImageResourceMetadata(source: string) {
  if (/^data:image\//i.test(source)) {
    return {
      bytes: byteSizeFromDataUrl(source),
      mimeType: source.match(/^data:([^;,]+)/i)?.[1] ?? "",
    };
  }
  if (typeof fetch === "undefined") return {};

  try {
    const response = await fetch(source, { method: "HEAD" });
    const mimeType = response.headers.get("content-type") ?? "";
    const length = response.headers.get("content-length");
    if (!length) return { mimeType };
    const bytes = Number.parseInt(length, 10);
    return {
      bytes: Number.isFinite(bytes) ? bytes : undefined,
      mimeType,
    };
  } catch {
    try {
      const response = await fetch(source);
      const blob = await response.blob();
      return {
        bytes: blob.size,
        mimeType: blob.type || response.headers.get("content-type") || "",
      };
    } catch {
      return {};
    }
  }
}

async function loadImageMetadata(source: string): Promise<ImageMetadata> {
  const [size, resource] = await Promise.all([
    loadIntrinsicImageSize(source),
    loadImageResourceMetadata(source),
  ]);

  return {
    status: "ready",
    format: imageFormatFromSource(source, resource.mimeType),
    width: size.width,
    height: size.height,
    bytes: resource.bytes,
  };
}

function imageInputId(groupId: string, index: number, kind: ImageEntityKind) {
  return `image-${groupId.replace(/[^a-z0-9_-]/gi, "-")}-${index}-${kind}`;
}

function displayValue(entity: EditableEntity) {
  if (entity.kind !== "text" || entity.composite) return entity.displayValue;
  return entity.displayValue.replace(/\s+/g, " ").trim();
}

function isShortTextValue(value: string) {
  return !value.includes("\n") && value.length <= 80;
}

function textAreaRows(value: string) {
  return Math.min(8, Math.max(2, value.split("\n").length, Math.ceil(value.length / 72)));
}


type VideoPreviewState = {
  phase: "idle" | "loading" | "ready" | "error";
  width?: number;
  height?: number;
};

type VideoPreviewEntry = {
  key: string;
  blockId: string;
  entity: EditableEntity;
  source: string;
  poster?: string;
  sourceType?: string;
  relatedEntityIds: string[];
};

type VideoStoryPresentation = { id: string; title: string; video: ImageGroup; related: ImageGroup[] };

function composeVideoStories(
  groups: ImageGroup[],
  entities: EditableEntity[],
  videoStoryByImageEntityId: Map<string, string>,
) {
  const stories: VideoStoryPresentation[] = [];
  const storyByVideoEntityId = new Map<string, string>();
  const storyByMediaGroupId = new Map<string, string>();
  const storyEntityByEntityId = new Map<string, string>();
  const relatedGroupIds = new Set<string>();
  for (const group of groups) {
    const video = group.items.find(item => isVideoEntity(item.entity))?.entity;
    if (!video) continue;
    const linked = linkedVideoEntities(entities, video);
    const canonicalId = linked[0]?.id ?? video.id;
    const story = { id: canonicalId, title: `ВИДЕО ${stories.length + 1}`, video: group, related: [] };
    stories.push(story);
    for (const entity of linked) {
      storyByVideoEntityId.set(entity.id, canonicalId);
      storyEntityByEntityId.set(entity.id, canonicalId);
    }
    if (video.context.type === "attribute" && video.context.mediaGroupId) {
      storyByMediaGroupId.set(video.context.mediaGroupId, canonicalId);
      for (const entity of entities) {
        if (entity.kind === "poster" && entity.context.type === "attribute" && entity.context.mediaGroupId === video.context.mediaGroupId) {
          for (const linkedPoster of linkedVideoEntities(entities, entity)) storyEntityByEntityId.set(linkedPoster.id, canonicalId);
        }
      }
    }
  }
  for (const [imageEntityId, videoEntityId] of videoStoryByImageEntityId) {
    const storyId = storyByVideoEntityId.get(videoEntityId);
    if (storyId) storyEntityByEntityId.set(imageEntityId, storyId);
  }
  for (const group of groups) {
    if (group.items.some(item => isVideoEntity(item.entity))) continue;
    let storyId = group.items.map(item => storyEntityByEntityId.get(item.entity.id)).find(Boolean);
    if (!storyId) {
      const mediaGroupId = group.items.find(item => item.entity.context.type === "attribute")?.entity.context;
      if (mediaGroupId?.type === "attribute" && mediaGroupId.mediaRole === "video-poster") {
        storyId = storyByMediaGroupId.get(mediaGroupId.mediaGroupId ?? "");
      }
    }
    const story = stories.find(candidate => candidate.id === storyId);
    if (story && (group.title === "Постер к видео" || group.title === "Медиа")) {
      story.related.push(group);
      relatedGroupIds.add(group.id);
    }
  }
  for (const story of stories) {
    story.related.sort((left, right) => Number(left.title !== "Постер к видео") - Number(right.title !== "Постер к видео"));
    for (const group of story.related) {
      for (const item of group.items) storyEntityByEntityId.set(item.entity.id, story.id);
      if (group.altEntity) storyEntityByEntityId.set(group.altEntity.id, story.id);
    }
  }
  return { stories, relatedGroupIds, storyEntityByEntityId };
}

function centeredRailScrollLeft(rail: HTMLElement, card: HTMLElement) {
  const railRect = rail.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const desired = rail.scrollLeft + cardRect.left - railRect.left + cardRect.width / 2 - rail.clientWidth / 2;
  return Math.max(0, Math.min(desired, Math.max(0, rail.scrollWidth - rail.clientWidth)));
}

function videoPreviewEntries(blocks: BlockSource[]): VideoPreviewEntry[] {
  return blocks.flatMap(block => {
    const { entities, videoStoryByImageEntityId } = extractEditableEntitiesWithVideoStories(assembleBlock(block).source);
    const valueFor = (entity: EditableEntity) => block.values[editorEntityKey(block.id, entity.id)] ?? entity.displayValue;
    const groups = groupImageEntities(entities);
    const { stories, storyEntityByEntityId } = composeVideoStories(groups, entities, videoStoryByImageEntityId);
    return stories.map(story => {
      const group = story.video;
      const entity = group.items[0].entity;
      const poster = videoPosterEntity(entities, entity);
      const relatedEntityIds = [...storyEntityByEntityId]
        .filter(([, storyId]) => storyId === story.id)
        .map(([entityId]) => entityId);
      return {
        key: editorEntityKey(block.id, entity.id), blockId: block.id, entity,
        source: valueFor(entity).trim(), poster: poster ? valueFor(poster).trim() : undefined,
        sourceType: entity.context.type === "attribute" ? entity.context.sourceType : undefined,
        relatedEntityIds: [...relatedEntityIds],
      };
    });
  });
}

function intrinsicFrameStyle(width?: number, height?: number, maxWidth = 148, maxHeight = 136): CSSProperties | undefined {
  if (!width || !height || width <= 0 || height <= 0) return undefined;
  const ratio = width / height;
  return { width: Math.min(maxWidth, maxHeight * ratio), aspectRatio: `${width} / ${height}` };
}

function resetVideoElement(video: HTMLVideoElement) {
  video.pause();
  video.removeAttribute("src");
  video.load();
}

function startVideoPreview(video: HTMLVideoElement, source: string, update: (state: VideoPreviewState) => void) {
  let disposed = false;
  let failed = false;
  let dimensions: { width: number; height: number } | undefined;
  let sought = false;
  const current = () => !disposed && !failed && video.getAttribute("src") === source;
  const timeout = setTimeout(() => fail(), 20000);
  function fail() {
    if (!current()) return;
    clearTimeout(timeout);
    failed = true;
    resetVideoElement(video);
    update({ phase: "error" });
  }
  function frameReady() {
    if (!current() || !dimensions || !sought || video.readyState < 2) return;
    clearTimeout(timeout);
    video.pause();
    update({ phase: "ready", ...dimensions });
  }
  function metadata() {
    if (!current()) return;
    if (!(video.videoWidth > 0 && video.videoHeight > 0)) { fail(); return; }
    dimensions = { width: video.videoWidth, height: video.videoHeight };
    update({ phase: "loading", ...dimensions });
    const duration = video.duration;
    let target = Number.isFinite(duration) && duration >= 0 ? Math.min(0.075, duration / 2) : 0.075;
    if (video.seekable.length) {
      const start = video.seekable.start(0);
      const end = video.seekable.end(0);
      target = Math.max(start, Math.min(target, Math.max(start, end - 0.001)));
    }
    try {
      if (video.currentTime === target && !video.seeking) { sought = true; frameReady(); }
      else video.currentTime = target;
    } catch { fail(); }
  }
  function seeked() { if (current()) { sought = true; frameReady(); } }
  video.addEventListener("loadedmetadata", metadata);
  video.addEventListener("seeked", seeked);
  video.addEventListener("loadeddata", frameReady);
  video.addEventListener("error", fail);
  video.src = source;
  update({ phase: "loading" });
  video.load();
  return () => {
    disposed = true; // Old URL events cannot publish into the next lifecycle.
    clearTimeout(timeout);
    video.removeEventListener("loadedmetadata", metadata);
    video.removeEventListener("seeked", seeked);
    video.removeEventListener("loadeddata", frameReady);
    video.removeEventListener("error", fail);
    resetVideoElement(video);
  };
}

function observeVideoPreview(video: HTMLVideoElement, card: HTMLElement, source: string, update: (state: VideoPreviewState) => void) {
  let dispose: (() => void) | undefined;
  let initialized = false;
  let cancelled = false;
  const observer = new IntersectionObserver(entries => {
    if (cancelled || initialized || !entries.some(entry => entry.isIntersecting)) return;
    initialized = true;
    observer.disconnect();
    if (source) dispose = startVideoPreview(video, source, update);
    else update({ phase: "error" });
  }, { threshold: 0.01 });
  observer.observe(card);
  return () => { cancelled = true; observer.disconnect(); dispose?.(); };
}

function VideoThumbnail({ source, poster }: { source: string; poster?: string }) {
  const [state, setState] = useState<VideoPreviewState>({ phase: "idle" });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!videoRef.current || !frameRef.current) return;
    return observeVideoPreview(videoRef.current, frameRef.current, source, setState);
  }, [source]);
  return <span ref={frameRef} className={styles.videoCardFrame} style={intrinsicFrameStyle(state.width, state.height, 300, 220)}>
    <video ref={videoRef} muted playsInline preload="metadata" poster={state.phase === "ready" ? undefined : poster} aria-hidden="true" />
    {state.phase === "error" && poster ? <>
      {/* Explicit poster fallback only; a video URL is never passed to an image. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={poster} alt="" />
    </> : null}
    <span className={styles.videoPlayIndicator} aria-hidden="true">▶</span>
    <span className={styles.videoFrameCaption}>{state.width && state.height
      ? `${state.width} × ${state.height}` : state.phase === "loading" ? "Загрузка…" : "Видео"}</span>
  </span>;
}

function VideoGallery({ entries, selectedKey, onOpen }: {
  entries: VideoPreviewEntry[];
  selectedKey?: string;
  onOpen: (entry: VideoPreviewEntry, trigger: HTMLElement) => void;
}) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (!selectedKey) return;
    const rail = railRef.current;
    const card = cardRefs.current.get(selectedKey);
    if (!rail || !card) return;
    rail.scrollTo({ left: centeredRailScrollLeft(rail, card), behavior: "smooth" });
  }, [selectedKey]);
  return <section className={styles.videoGallery} aria-label="Предпросмотр видео">
    <div className={styles.panelHeader}><strong>ПРЕДПРОСМОТР ВИДЕО</strong><span>{entries.length}</span></div>
    <div className={styles.videoRail} ref={railRef}>
      {entries.map((entry, index) => <button type="button" key={entry.key} ref={node => { if (node) cardRefs.current.set(entry.key, node); else cardRefs.current.delete(entry.key); }} className={styles.videoCard}
        aria-pressed={selectedKey === entry.key} aria-label={`Открыть видео ${index + 1}`}
        onClick={event => onOpen(entry, event.currentTarget)}>
        <VideoThumbnail key={`${entry.key}:${entry.source}`} source={entry.source} poster={entry.poster} />
        <span>{entry.sourceType?.startsWith("video/") ? entry.sourceType.slice(6).toUpperCase() : "Видео"} · {index + 1}</span>
      </button>)}
    </div>
  </section>;
}

function bindVideoDialog(dialog: HTMLElement, trigger: HTMLElement | null, close: () => void) {
  const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>('button, video[controls], a[href], input, select, textarea, [tabindex]'))
    .filter(node => node.tabIndex >= 0 && !node.hasAttribute("disabled") && !node.hidden);
  function keydown(event: KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key !== "Tab") return;
    const items = controls();
    const first = items[0] ?? dialog;
    const last = items.at(-1) ?? dialog;
    if (!dialog.contains(document.activeElement) || document.activeElement === dialog ||
      (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }
  (controls()[0] ?? dialog).focus();
  document.addEventListener("keydown", keydown, true);
  return () => { document.removeEventListener("keydown", keydown, true); if (trigger?.isConnected) trigger.focus(); };
}

function VideoModal({ entry, trigger, onClose }: { entry: VideoPreviewEntry; trigger: HTMLElement | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const video = videoRef.current;
    if (!dialog || !video) return;
    const restoreFocus = bindVideoDialog(dialog, trigger, onClose);
    video.src = entry.source;
    video.load();
    return () => { resetVideoElement(video); restoreFocus(); };
  }, [entry.source, trigger, onClose]);
  return createPortal(<div className={styles.modalBackdrop} data-ui-theme="editor" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className={styles.videoModal} role="dialog" aria-modal="true" aria-label="Предпросмотр видео" tabIndex={-1}>
      <div className={styles.modalHeader}><h2>Предпросмотр видео</h2><button type="button" className={styles.secondaryButton} onClick={onClose}>Закрыть</button></div>
      <video ref={videoRef} controls playsInline preload="metadata" poster={entry.poster} />
    </section>
  </div>, document.body);
}

function IntrinsicImagePreview({ source, metadata }: { source: string; metadata?: ImageMetadata }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  return <div className={styles.imagePreviewFrame} style={intrinsicFrameStyle(size?.width ?? metadata?.width, size?.height ?? metadata?.height)}>
    {canPreviewImage(source) ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img className={styles.imagePreview} src={source} alt="" onLoad={event => {
        event.currentTarget.hidden = false;
        setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
      }} onError={event => { event.currentTarget.hidden = true; }} />
    ) : null}
  </div>;
}

type BlockFieldsProps = {
  block: BlockSource; index: number;
  selected: { blockId: string; entityId: string; revision: number } | null;
  onSelectVideo: (blockId: string, entityId: string) => void;
  onChange: (block: BlockSource) => void; send: (command: PreviewCommand) => void;
};
function BlockFields({ block, index, selected, onChange, send, onSelectVideo }: BlockFieldsProps) {
  const [copyFeedback, setCopyFeedback] = useState("");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  const source = assembleBlock(block).source;
  const values = useMemo(() => Object.fromEntries(Object.entries(block.values).map(([key,value]) => [key.slice(block.id.length+2),value])), [block.id, block.values]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [openSlideById, setOpenSlideById] = useState<Record<string, boolean>>({});
  const [activeSlideBySliderId, setActiveSlideBySliderId] = useState<Record<string, number>>({});
  const [imageMetadataByUrl, setImageMetadataByUrl] = useState<Record<string, ImageMetadata>>({});
  const imageMetadataCacheRef = useRef(new Map<string, ImageMetadata | Promise<ImageMetadata>>());
  const contentGroupRefs = useRef<Record<string, HTMLElement | null>>({});
  const previewAccordionControllerRef = useRef<{ openForEntity: (id: string) => void } | null>(null);
  useEffect(() => {
    previewAccordionControllerRef.current = { openForEntity: entityId => send({ type: "reveal", blockId: block.id, entityId }) };
    return () => { previewAccordionControllerRef.current = null; };
  }, [block.id, send]);
  const extraction = useMemo(() => {
    try {
      return {
        ...extractEditableEntitiesWithVideoStories(source),
        error: "",
      };
    } catch {
      return {
        entities: [],
        videoStoryByImageEntityId: new Map<string, string>(),
        error: "Не удалось разобрать этот HTML в текущем ограниченном режиме.",
      };
    }
  }, [source]);

  const hasSource = source.trim().length > 0;

  const sliderGroups = useMemo(
    () => detectSliderGroups(source, extraction.entities),
    [extraction.entities, source],
  );
  const accordionGroups = useMemo(
    () => detectAccordionGroups(source, extraction.entities),
    [extraction.entities, source],
  );
  const accordionControlEntityIds = useMemo(
    () => new Set(accordionGroups.flatMap(group => group.controlEntityIds)),
    [accordionGroups],
  );
  const contentEntities = useMemo(
    () => extraction.entities.filter(entity => !accordionControlEntityIds.has(entity.id) &&
      linkedVideoEntities(extraction.entities, entity)[0]?.id === entity.id),
    [accordionControlEntityIds, extraction.entities],
  );
  const sliderSlideEntityIds = useMemo(
    () => new Set(sliderGroups.flatMap((group) => group.slideEntityIds)),
    [sliderGroups],
  );
  const sliderControlEntityIds = useMemo(
    () => new Set(sliderGroups.flatMap((group) => group.controlEntityIds)),
    [sliderGroups],
  );
  const sliderExcludedEntityIds = useMemo(
    () => new Set([...sliderSlideEntityIds, ...sliderControlEntityIds]),
    [sliderControlEntityIds, sliderSlideEntityIds],
  );
  const accordionContentItems = useMemo(
    () => buildAccordionContentItems(
      source,
      contentEntities.filter(entity => !sliderExcludedEntityIds.has(entity.id)),
      accordionGroups,
    ),
    [accordionGroups, contentEntities, sliderExcludedEntityIds, source],
  );
  const accordionOwnedEntityIds = useMemo(
    () => new Set(accordionContentItems.flatMap(item => item.ownedEntityIds)),
    [accordionContentItems],
  );
  const repeatingGroups = useMemo(
    () =>
      detectRepeatingGroups(
        source,
        contentEntities.filter(entity => !accordionOwnedEntityIds.has(entity.id)),
      ).filter((group) =>
        group.items.every((item) => item.entityIds.every((entityId) => !sliderExcludedEntityIds.has(entityId))),
      ),
    [accordionOwnedEntityIds, contentEntities, sliderExcludedEntityIds, source],
  );
  const repeatingEntityIds = useMemo(
    () => new Set(repeatingGroups.flatMap((group) => group.items.flatMap((item) => item.entityIds))),
    [repeatingGroups],
  );
  const contentGroups = useMemo(
    () =>
      buildContentGroups(
        source,
        contentEntities.filter(
          (entity) => !isImageGroupEntity(entity) &&
            !sliderExcludedEntityIds.has(entity.id) &&
            !accordionOwnedEntityIds.has(entity.id),
        ),
        repeatingEntityIds,
      ),
    [accordionOwnedEntityIds, contentEntities, repeatingEntityIds, sliderExcludedEntityIds, source],
  );
  const imageGroups = useMemo(
    () => groupImageEntities(
      contentEntities.filter(
        (entity) => !repeatingEntityIds.has(entity.id) &&
          !sliderExcludedEntityIds.has(entity.id) &&
          !accordionOwnedEntityIds.has(entity.id),
      ),
    ),
    [accordionOwnedEntityIds, contentEntities, repeatingEntityIds, sliderExcludedEntityIds],
  );
  const videoStories = useMemo(
    () => composeVideoStories(imageGroups, extraction.entities, extraction.videoStoryByImageEntityId),
    [extraction.entities, extraction.videoStoryByImageEntityId, imageGroups],
  );
  const videoStoryEntityByEntityId = videoStories.storyEntityByEntityId;
  const imageUrls = useMemo(
    () =>
      Array.from(
        new Set(
          extraction.entities
            .filter(usesImageMetadata)
            .map((entity) => imageMetadataKey(values[entity.id] ?? displayValue(entity)))
            .filter(Boolean),
        ),
      ),
    [extraction.entities, values],
  );
  const blockingValidationIssues = useMemo(
    () => validateRequiredImageValues(extraction.entities, values),
    [extraction.entities, values],
  );
  const blockingValidationIssueByEntityId = useMemo(
    () => new Map(blockingValidationIssues.map((issue) => [issue.entityId, issue])),
    [blockingValidationIssues],
  );
  const hasChanges = isBlockContentDirty(block);
  const hasInvalidContent = blockHasInvalidContent(block);
  async function copyBlockCode() {
    if (!hasChanges || hasInvalidContent || blockingValidationIssues.length) return;
    try {
      await navigator.clipboard.writeText(exportBlock(block));
      setCopyFeedback("СКОПИРОВАНО");
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyFeedback(""), 1800);
    } catch { setCopyFeedback("Не удалось скопировать код."); }
  }
  useEffect(() => {
    let cancelled = false;
    for (const url of imageUrls) {
      let request = imageMetadataCacheRef.current.get(url);
      if (!request) {
        request = loadImageMetadata(url);
        imageMetadataCacheRef.current.set(url, request);
      }
      Promise.resolve(request).then(metadata => {
        imageMetadataCacheRef.current.set(url, metadata);
        if (!cancelled) setImageMetadataByUrl(current => ({ ...current, [url]: metadata }));
      });
    }
    return () => { cancelled = true; };
  }, [imageUrls]);
  function updateValue(entity: EditableEntity, value: string) {
    setCopyFeedback("");
    const key = editorEntityKey(block.id, entity.id);
    const nextValues = { ...block.values };
    for (const linked of linkedVideoEntities(extraction.entities, entity)) {
      nextValues[editorEntityKey(block.id, linked.id)] = value;
    }
    if (compositeEditError(entity, value)) {
      const previous = block.values[key] ?? entity.displayValue;
      nextValues[`${key}::valid`] = compositeEditError(entity, previous) ? block.values[`${key}::valid`] ?? entity.displayValue : previous;
    } else delete nextValues[`${key}::valid`];
    onChange({ ...block, values: nextValues });
  }
  function resetChanges() { setCopyFeedback(""); onChange({ ...block, fragments: block.fragments.map(fragment => ({ ...fragment, source: fragment.originalSource, draft: fragment.originalSource })), values: {} }); }
  function focusEntity(entityId: string) { const entityIndex = extraction.entities.findIndex(entity => entity.id === entityId); if (entityIndex >= 0) send({ type: "highlight", markerIds: ["block-" + (index+1) + "-tm-" + (entityIndex+1)] }); }
  function scrollContentGroupIntoView(groupId: string, field?: HTMLElement | null) {
    requestAnimationFrame(() => {
      const target = field ?? contentGroupRefs.current[groupId];
      if (!target) return;
      const accordionItem = target.closest<HTMLDetailsElement>('details[data-accordion-content-item]');
      if (accordionItem) accordionItem.open = true;
      let parent = target.parentElement;
      while (parent) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
      }
      parent = target.parentElement;
      while (parent) {
        if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) {
          const bounds = target.getBoundingClientRect();
          const container = parent.getBoundingClientRect();
          if (bounds.top < container.top || bounds.bottom > container.bottom) parent.scrollTo({ top: parent.scrollTop + bounds.top - container.top - 16, behavior: "smooth" });
          return;
        }
        parent = parent.parentElement;
      }
      target.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }
  useEffect(() => {
    if (!selected || selected.blockId !== block.id) return;
    if (videoStoryEntityByEntityId.has(selected.entityId)) return;
    const groupByEntityId = new Map<string, string>();
    for (const item of accordionContentItems) for (const entityId of item.ownedEntityIds) groupByEntityId.set(entityId, item.id);
    for (const group of contentGroups) for (const entity of group.entities) groupByEntityId.set(entity.id, group.id);
    for (const slider of sliderGroups) for (const slide of slider.slides) for (const id of slide.entityIds) groupByEntityId.set(id, slide.id);
    scrollContentGroupIntoView(groupByEntityId.get(selected.entityId) ?? "", contentGroupRefs.current["entity:" + selected.entityId]);
  }, [selected, block.id, accordionContentItems, contentGroups, sliderGroups, videoStoryEntityByEntityId]);
  function contentGroupInteractionProps(groupId: string) { return { ref: (node: HTMLElement | null) => { contentGroupRefs.current[groupId] = node; }, onFocusCapture: () => setActiveGroupId(groupId), onMouseEnter: () => setActiveGroupId(groupId) }; }
  function activateSlide(sliderId: string, slide: SlideGroup) {
    const path = sliderActivationPath(sliderGroups, sliderId, slide.index);
    for (const step of path) send({ type: "slide", blockId: block.id, widgetGroupId: editorEntityKey(block.id, step.sliderId), index: step.slide.index });
    setActiveGroupId(slide.id);
    setActiveSlideBySliderId(current => ({ ...current, ...Object.fromEntries(path.map(step => [step.sliderId, step.slide.index])) }));
    setOpenSlideById(current => ({ ...current, ...Object.fromEntries(path.map(step => [step.slide.id, true])) }));
  }
  function slideGroupInteractionProps(sliderId: string, slide: SlideGroup) { return { ref: (node: HTMLElement | null) => { contentGroupRefs.current[slide.id] = node; }, onFocusCapture: () => activateSlide(sliderId,slide), onMouseEnter: () => activateSlide(sliderId,slide) }; }
  function valueFor(entity: EditableEntity) {
    return values[entity.id] ?? displayValue(entity);
  }

  function imageMetadataPrefix(entity: EditableEntity) {
    if (entity.kind === "poster" || (entity.context.type === "attribute" && entity.context.mediaRole === "video-poster")) {
      return "Постер к видео";
    }
    if (entity.context.type === "attribute" && entity.context.mediaRole === "video") {
      return "Видео";
    }
    if (entity.context.type === "attribute" && entity.context.fallback) {
      return "Основное изображение";
    }
    if (entity.context.type === "css-url") {
      return "Фоновое изображение";
    }
    return "";
  }

  function imageMetadataText(entity: EditableEntity) {
    if (!usesImageMetadata(entity)) {
      return imageMetadataPrefix(entity) || "Медиа";
    }
    const url = imageMetadataKey(valueFor(entity));
    const metadata = imageMetadataLine(url, imageMetadataByUrl[url]);
    const prefix = imageMetadataPrefix(entity);
    return prefix ? `${prefix} · ${metadata}` : metadata;
  }

  function renderImageUrlControl(
    entity: EditableEntity,
    inputId: string,
    options: { metadataText?: string } = {},
  ) {
    inputId = block.id + "-" + inputId;
    const issue = blockingValidationIssueByEntityId.get(entity.id);
    const descriptionId = issue ? `${inputId}-description` : undefined;
    const metadataText = options.metadataText ?? (entity.context.type === "attribute" && entity.context.mediaRole === "video"
      ? "Ссылка на видео" : imageMetadataText(entity));

    return (
      <div className={`${styles.imageUrlControl} ${issue ? styles.fieldWarning : ""}`} ref={node => { contentGroupRefs.current[`entity:${entity.id}`] = node; }}>
        <div className={styles.mediaFieldHeader}>
          <label htmlFor={inputId}>
            <span className={styles.imageMetadata} aria-live="polite">
              {metadataText}
            </span>
          </label>
          <button
            type="button"
            className={styles.mediaClearButton}
            onClick={() => updateValue(entity, "")}
            aria-label="Очистить медиа"
            title="Очистить медиа"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
              <path d="M9 3h6l1 2h4v2H4V5h4l1-2Z" />
              <path d="M6 9h12l-1 11H7L6 9Zm4 2v7h2v-7h-2Zm4 0v7h2v-7h-2Z" />
            </svg>
          </button>
        </div>
        <input
          id={inputId}
          type="text"
          value={valueFor(entity)}
          onChange={(event) => updateValue(entity, event.target.value)}
          onFocus={() => {
            const storyVideoId = videoStoryEntityByEntityId.get(entity.id);
            if (storyVideoId) onSelectVideo(block.id, storyVideoId);
          }}
          aria-invalid={issue ? true : undefined}
          aria-describedby={descriptionId}
        />
        {issue ? (
          <div className={styles.warningText} id={descriptionId}>
            <p>{issue.message}</p>
          </div>
        ) : null}
      </div>
    );
  }

  function renderAltControl(entity: EditableEntity & { kind: "alt" }, inputId: string) {
    return (
      <div className={styles.altField}>
        <label htmlFor={inputId}>ALT изображения</label>
        <input
          id={inputId}
          type="text"
          value={valueFor(entity)}
          onChange={(event) => updateValue(entity, event.target.value)}
        />
      </div>
    );
  }

  function renderImageGroupContent(group: ImageGroup, inputPrefix: string, options: { storyField?: boolean } = {}) {
    const items = group.items.filter(item => linkedVideoEntities(extraction.entities, item.entity)[0]?.id === item.entity.id);
    if (!items.length && !group.altEntity) return null;
    const previewEntity =
      group.items.find((item) => usesImageMetadata(item.entity))?.entity ??
      group.items.at(-1)?.entity ??
      group.items[0]?.entity;

    return (
      <div className={`${styles.imageGroupItems} ${previewEntity && isVideoEntity(previewEntity) ? styles.videoUrlFields : ""}`}>
        {previewEntity && usesImageMetadata(previewEntity) ? <IntrinsicImagePreview
          key={valueFor(previewEntity)} source={valueFor(previewEntity)} metadata={imageMetadataByUrl[imageMetadataKey(valueFor(previewEntity))]}
        /> : null}
        <div className={styles.imageFields}>
          {items.map((item, index) => {
            const inputId = imageInputId(`${inputPrefix}-${group.id}`, index, item.entity.kind);
            const isVideoVariant =
              item.entity.context.type === "attribute" &&
              item.entity.context.mediaRole === "video";

            return (
              <div className={styles.imageField} key={item.entity.id}>
                {item.label && !options.storyField ? <p className={styles.imageMetadata}>{item.label}</p> : null}
                {item.detail ? <p className={styles.imageMetadata}>{item.detail}</p> : null}
                {renderImageUrlControl(item.entity, inputId, {
                  metadataText: isVideoVariant ? "Ссылка на видео" : options.storyField ? group.title : undefined,
                })}
              </div>
            );
          })}
          {group.altEntity ? (
            <div className={styles.imageField} key={group.altEntity.id}>
              {renderAltControl(
                group.altEntity,
                `alt-${inputPrefix}-${group.id.replace(/[^a-z0-9_-]/gi, "-")}`,
              )}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  function renderSliderGroup(group: SliderGroup) {
    const activeSlideIndex = activeSlideBySliderId[group.id] ?? 0;
    return (
      <section className={styles.sliderGroup} key={group.id}>
        <div className={styles.sliderGroupHeader}>
          <span>
            <small>{group.mediaOnly ? "Галерея" : `Слайдер · ${group.pattern}`}</small>
            <strong>{group.slides.length} слайдов</strong>
          </span>
        </div>
        <div className={styles.slideGroups}>
          {group.slides.map((slide) => {
            const slideEntities = slide.entityIds
              .map((entityId) => extraction.entities.find((entity) => entity.id === entityId))
              .filter((entity): entity is EditableEntity => Boolean(entity));
            const slideContentGroups = buildContentGroups(
              source,
              slideEntities.filter((entity) => !isImageGroupEntity(entity)),
            );
            const slideImageGroups = groupImageEntities(slideEntities.filter(isImageGroupEntity));
            const issueCount = blockingValidationIssues.filter((issue) =>
              slide.entityIds.includes(issue.entityId),
            ).length;
            const isActive = activeSlideIndex === slide.index || activeGroupId === slide.id;
            const isOpen = isActive || openSlideById[slide.id];

            return (
              <details
                className={`${styles.slideGroup} ${isActive ? styles.activeContentGroup : ""}`}
                key={slide.id}
                open={isOpen}
                onToggle={(event) => {
                  const details = event.currentTarget;
                  setOpenSlideById((current) => ({
                    ...current,
                    [slide.id]: details.open,
                  }));
                }}
                {...slideGroupInteractionProps(group.id, slide)}
              >
                <summary onClick={() => activateSlide(group.id, slide)}>
                  <span>{slide.label ?? `${group.mediaOnly ? "Фото" : "Слайд"} ${slide.index + 1}`}</span>
                  {issueCount > 0 ? <em>{issueCount} ошибка</em> : null}
                </summary>
                <div className={styles.slideGroupBody}>
                  {slideContentGroups.map((contentGroup, contentIndex) => (
                    <div className={styles.slideContentBlock} key={contentGroup.id}>
                      {contentGroup.kind === "link" ? (
                        <>
                          <h3>{contentGroup.label}</h3>
                          {contentGroup.textEntities.map((entity, entityIndex) =>
                            renderValueControl(
                              entity,
                              `slide-${slide.id}-text-${contentIndex}-${entityIndex}`,
                              {
                                hideLabel: contentGroup.textEntities.length === 1,
                                label: "Текст",
                              },
                            ),
                          )}
                          {renderValueControl(
                            contentGroup.hrefEntity,
                            `slide-${slide.id}-href-${contentIndex}`,
                          )}
                        </>
                      ) : (
                        <>
                          <h3>{contentGroup.label}</h3>
                          {contentGroup.entities.map((entity, entityIndex) =>
                            renderValueControl(
                              entity,
                              `slide-${slide.id}-content-${contentIndex}-${entityIndex}`,
                              {
                                hideLabel: contentGroup.entities.length === 1,
                              },
                            ),
                          )}
                        </>
                      )}
                    </div>
                  ))}
                  {slideImageGroups.map((imageGroup, imageIndex) => (
                    <div className={styles.slideContentBlock} key={imageGroup.id}>
                      <h3>{imageGroup.title}</h3>
                      {renderImageGroupContent(imageGroup, `slide-${slide.id}-${imageIndex}`)}
                    </div>
                  ))}
                  {sliderGroups.filter(child => child.parentSlideId === slide.id).map(renderSliderGroup)}
                </div>
              </details>
            );
          })}
        </div>
      </section>
    );
  }

  function renderValueControl(
    entity: EditableEntity,
    inputId: string,
    options: { hideLabel?: boolean; label?: string } = {},
  ) {
    inputId = block.id + "-" + inputId;
    const value = valueFor(entity);
    const label = options.label ?? fieldLabel(entity);
    const lengthInfo = textLengthWarning(entity, value);
    const hasLengthWarning = Boolean(lengthInfo?.overLimit || lengthInfo?.hasExtraLineBreaks);
    const compositeError = compositeEditError(entity, value);
    const issue = compositeError ? { message: compositeError } : blockingValidationIssueByEntityId.get(entity.id);
    const descriptionId = hasLengthWarning || issue ? `${inputId}-description` : undefined;
    const shortText = entity.kind === "text" && isShortTextValue(value);

    return (
      <div
        className={`${styles.lineField} ${hasLengthWarning || issue ? styles.fieldWarning : ""}`}
        key={entity.id}
        ref={(node) => { contentGroupRefs.current[`entity:${entity.id}`] = node; }}
        onFocus={() => {
          previewAccordionControllerRef.current?.openForEntity(entity.id);
          focusEntity(entity.id);
        }}
        onMouseEnter={() => focusEntity(entity.id)}
      >
        {options.hideLabel ? null : <label htmlFor={inputId}>{label}</label>}
        {entity.kind === "text" && !shortText ? (
          <textarea
            id={inputId}
            aria-label={label}
            value={value}
            rows={textAreaRows(value)}
            onChange={(event) => updateValue(entity, event.target.value)}
            aria-invalid={issue ? true : undefined}
            aria-describedby={descriptionId}
          />
        ) : (
          <input
            id={inputId}
            type="text"
            aria-label={label}
            value={value}
            onChange={(event) => updateValue(entity, event.target.value)}
            aria-invalid={issue ? true : undefined}
            aria-describedby={descriptionId}
          />
        )}
        {lengthInfo ? (
          <div className={styles.fieldFooter}>
            <span
              className={lengthInfo.overLimit ? styles.lengthCounterWarning : styles.lengthCounter}
            >
              {lengthInfo.overLimit
                ? `${lengthInfo.currentLength} символов · было ${lengthInfo.originalLength} · +${lengthInfo.overflow}`
                : `${lengthInfo.currentLength} из ${lengthInfo.originalLength} символов`}
            </span>
          </div>
        ) : null}
        {(lengthInfo && hasLengthWarning) || issue ? (
          <div className={styles.warningText} id={descriptionId}>
            {lengthInfo?.overLimit ? <p>{lengthInfo.message}</p> : null}
            {lengthInfo?.hasExtraLineBreaks ? <p>{lengthInfo.lineBreakMessage}</p> : null}
            {issue ? <p>{issue.message}</p> : null}
          </div>
        ) : null}
      </div>
    );
  }

  function renderContentGroup(group: ContentGroup, index: number) {
    if (group.kind === "link") {
      return (
        <section
          className={`${styles.contentGroup} ${activeGroupId === group.id ? styles.activeContentGroup : ""}`}
          key={group.id}
          {...contentGroupInteractionProps(group.id)}
        >
          <h2>{group.label}</h2>
          {group.textEntities.map((entity, entityIndex) =>
            renderValueControl(entity, `content-${index}-text-${entityIndex}`, {
              hideLabel: group.textEntities.length === 1,
              label: "Текст",
            }),
          )}
          {renderValueControl(group.hrefEntity, `content-${index}-href`)}
        </section>
      );
    }

    const composite = group.entities.length > 1;
    return (
      <section
        className={`${styles.contentGroup} ${activeGroupId === group.id ? styles.activeContentGroup : ""}`}
        key={group.id}
        {...contentGroupInteractionProps(group.id)}
      >
        <h2>{group.label}</h2>
        {composite ? (
          <div className={styles.compositeField}>
            {group.entities.map((entity) => (
              <label key={entity.id}>
                <input
                  type="text"
                  aria-label={fieldLabel(entity)}
                  value={valueFor(entity)}
                  onChange={(event) => updateValue(entity, event.target.value)}
                  onFocus={() => previewAccordionControllerRef.current?.openForEntity(entity.id)}
                />
              </label>
            ))}
          </div>
        ) : (
          renderValueControl(group.entities[0], `content-${index}-text`, { hideLabel: true })
        )}
      </section>
    );
  }

  function renderAccordionContentItem(item: AccordionContentItem, index: number) {
    const entityById = new Map(extraction.entities.map(entity => [entity.id, entity]));

    function renderSection(
      entityIds: string[],
      groups: ContentGroup[],
      primaryLabel: "Вопрос" | "Ответ",
    ) {
      const entities = entityIds
        .map(entityId => entityById.get(entityId))
        .filter((entity): entity is EditableEntity => Boolean(entity));
      const imageGroups = groupImageEntities(entities.filter(isImageGroupEntity));
      const entries = [
        ...groups.map(group => ({
          kind: "content" as const,
          id: group.id,
          start: Math.min(...group.entities.map(entity => entity.range.start)),
          group,
        })),
        ...imageGroups.map(group => ({
          kind: "image" as const,
          id: group.id,
          start: Math.min(
            ...group.items.map(entry => entry.entity.range.start),
            group.altEntity?.range.start ?? Number.POSITIVE_INFINITY,
          ),
          group,
        })),
      ].sort((left, right) => left.start - right.start);

      return entries.map((entry, entryIndex) => (
        <div className={styles.slideContentBlock} key={`${primaryLabel}-${entry.id}`}>
          <h3>{entryIndex === 0
            ? primaryLabel
            : entry.kind === "image" ? entry.group.title : entry.group.label}</h3>
          {entry.kind === "image" ? (
            renderImageGroupContent(entry.group, `accordion-${index}-${primaryLabel}-${entryIndex}`)
          ) : entry.group.kind === "link" ? (
            (() => {
              const linkGroup = entry.group;
              return (
                <>
                  {linkGroup.textEntities.map((entity, entityIndex) =>
                    renderValueControl(entity, `accordion-${index}-${primaryLabel}-text-${entryIndex}-${entityIndex}`, {
                      hideLabel: linkGroup.textEntities.length === 1,
                      label: "Текст",
                    }),
                  )}
                  {renderValueControl(
                    linkGroup.hrefEntity,
                    `accordion-${index}-${primaryLabel}-href-${entryIndex}`,
                  )}
                </>
              );
            })()
          ) : (
            entry.group.entities.map((entity, entityIndex) =>
              renderValueControl(
                entity,
                `accordion-${index}-${primaryLabel}-content-${entryIndex}-${entityIndex}`,
                { hideLabel: entry.group.entities.length === 1 },
              ),
            )
          )}
        </div>
      ));
    }

    return (
      <details
        className={`${styles.slideGroup} ${activeGroupId === item.id ? styles.activeContentGroup : ""}`}
        data-accordion-content-item
        key={item.id}
        {...contentGroupInteractionProps(item.id)}
      >
        <summary><span>Вопрос {index + 1}</span></summary>
        <div className={styles.slideGroupBody}>
          {renderSection(item.questionEntityIds, item.questionGroups, "Вопрос")}
          {renderSection(item.answerEntityIds, item.answerGroups, "Ответ")}
        </div>
      </details>
    );
  }


 return (<div className={styles.editPanel}>
          <div className={styles.panelHeader}>
            <span>
              <small>БЛОК {index + 1} · Содержимое</small>
              <strong>{hasSource ? `${contentEntities.length} полей` : "Пока пусто"}</strong>
            </span>
            <div className={styles.contentActions}>
            {hasChanges ? <button type="button" className={styles.primaryButton} disabled={hasInvalidContent || blockingValidationIssues.length > 0} onClick={copyBlockCode}>{copyFeedback === "СКОПИРОВАНО" ? copyFeedback : "СКОПИРОВАТЬ КОД БЛОКА"}</button> : null}
            <button type="button" onClick={resetChanges} disabled={!hasChanges && !hasInvalidContent}>
              Сбросить
            </button>
            {copyFeedback ? <span role="status" className={styles.copyFeedback}>{copyFeedback}</span> : null}
            </div>
          </div>

          {!hasSource ? (
            <p className={styles.emptyState}>
              Загрузите код, чтобы увидеть тексты, ссылки и изображения, которые можно
              изменить.
            </p>
          ) : extraction.error ? (
            <p className={styles.errorState}>{extraction.error}</p>
          ) : extraction.entities.length === 0 ? (
            <p className={styles.emptyState}>
              В этом коде пока не найден поддерживаемый для редактирования контент.
            </p>
          ) : (
            <div className={styles.fields} data-content-scroll style={{ maxHeight: "calc(100dvh - 180px)", overflowY: "auto" }}>
              {accordionContentItems.length > 0 ? (
                <section className={styles.sliderGroup}>
                  <div className={styles.sliderGroupHeader}>
                    <span>
                      <small>Аккордеон</small>
                      <strong>{accordionContentItems.length} вопросов</strong>
                    </span>
                  </div>
                  <div className={styles.slideGroups}>
                    {accordionContentItems.map(renderAccordionContentItem)}
                  </div>
                </section>
              ) : null}

              {contentGroups.map(renderContentGroup)}

              {sliderGroups.filter(group => !group.parentSliderId).map(renderSliderGroup)}

              {repeatingGroups.map((group) => {
                const isMediaGroup = group.groupKind === "image";

                return (
                <section className={styles.repeatingGroup} key={group.id}>
                  <div className={styles.repeatingHeader}>
                    <span>
                      <small>Повторяющаяся группа</small>
                      <strong>{isMediaGroup ? mediaTitleForEntities(extraction.entities.filter(entity => group.items.some(item => item.entityIds.includes(entity.id)))) : group.title}</strong>
                    </span>
                  </div>
                  <div className={styles.repeatingItems}>
                    {group.items.map((item, itemIndex) => {
                      const itemEntities = item.entityIds
                        .map((entityId) => extraction.entities.find((entity) => entity.id === entityId))
                        .filter((entity): entity is EditableEntity => Boolean(entity) && linkedVideoEntities(extraction.entities, entity!)[0]?.id === entity!.id);
                      const itemGroupId = `repeat:${item.id}`;

                      return (
                        <div
                          className={`${styles.repeatingItem} ${
                            activeGroupId === itemGroupId ? styles.activeContentGroup : ""
                          }`}
                          key={item.id}
                          {...contentGroupInteractionProps(itemGroupId)}
                        >
                          <div className={styles.repeatingItemHeader}>
                            <strong>
                              {isMediaGroup
                                ? mediaTitleForEntities(itemEntities)
                                : group.tagName === "li"
                                  ? "Пункт"
                                  : "Абзац"}{" "}
                              {itemIndex + 1}
                            </strong>
                          </div>
                          {itemEntities.map((entity, entityIndex) => {
                            const inputId = `repeat-${item.id.replace(/[^a-z0-9_-]/gi, "-")}-${entityIndex}`;
                            return (
                              <div className={styles.repeatingField} key={entity.id}>
                                {isImageEntity(entity) ? (
                                  <div className={`${styles.repeatingUrlField} ${isVideoEntity(entity) ? styles.videoUrlFields : ""}`}>
                                    {usesImageMetadata(entity) ? <IntrinsicImagePreview key={valueFor(entity)} source={valueFor(entity)} metadata={imageMetadataByUrl[imageMetadataKey(valueFor(entity))]} /> : null}
                                    {renderImageUrlControl(entity, inputId)}
                                  </div>
                                ) : (
                                  renderValueControl(entity, inputId)
                                )}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                </section>
                );
              })}

              {videoStories.stories.map((story) => (
                <section
                  className={`${styles.imageGroup} ${
                    activeGroupId === story.id || (selected?.blockId === block.id && selected.entityId === story.id)
                      ? styles.activeContentGroup : ""
                  }`}
                  key={story.id}
                  onClick={() => onSelectVideo(block.id, story.id)}
                  onFocusCapture={() => setActiveGroupId(story.id)}
                >
                  <h2>{story.title}</h2>
                  {renderImageGroupContent(story.video, `story-${story.id}`, { storyField: true })}
                  {story.related
                    .map((group) => renderImageGroupContent(group, `story-${story.id}`, { storyField: true }))}
                </section>
              ))}
              {imageGroups.filter(group => !videoStories.relatedGroupIds.has(group.id) && !group.items.some(item => isVideoEntity(item.entity))).map((group) => (
                <section
                  className={`${styles.imageGroup} ${
                    activeGroupId === group.id ? styles.activeContentGroup : ""
                  }`}
                  key={group.id}
                  {...contentGroupInteractionProps(group.id)}
                >
                  <h2>{group.title}</h2>
                  {renderImageGroupContent(group, "image")}
                </section>
              ))}
            </div>
          )}
        </div>);
}

type SiteCodeField = { draft: string; source: string; loaded: boolean; locked: boolean };
type SiteCodeFields = { css: SiteCodeField; js: SiteCodeField };
export function emptySiteCodeField(): SiteCodeField { return { draft: "", source: "", loaded: false, locked: false }; }
export function updateSiteCodeField(field: SiteCodeField, action: "load" | "replace" | "delete" | "lock"): SiteCodeField {
  if (action === "load") return { ...field, source: field.draft, loaded: true };
  if (action === "replace") return { ...field, draft: "", source: "", loaded: false };
  if (action === "delete") return emptySiteCodeField();
  return { ...field, locked: !field.locked };
}
export function advanceSiteComposition(hadSource: boolean, hasSource: boolean, pending: boolean, fields: SiteCodeFields) {
  if (hadSource && !hasSource) return { fields, pending: true };
  if (!hadSource && hasSource && pending) return {
    fields: { css: fields.css.locked ? fields.css : emptySiteCodeField(), js: fields.js.locked ? fields.js : emptySiteCodeField() }, pending: false,
  };
  return { fields, pending };
}
function CodeTrashIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function CodeLockIcon({ locked }: { locked: boolean }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false"><path d={locked ? "M7 10V7a5 5 0 0 1 10 0v3" : "M7 10V7a5 5 0 0 1 9-3"} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><rect x="5" y="10" width="14" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M12 14v3" stroke="currentColor" strokeWidth="1.8" /></svg>;
}
export default function HtmlContentEditor() {
  const [blocks, setBlocks] = useState<BlockSource[]>(() => [createBlockSource("block-1")]);
  const nextId = useRef(2);
  const [siteFields, setSiteFields] = useState<SiteCodeFields>(() => ({ css: emptySiteCodeField(), js: emptySiteCodeField() }));
  const newCompositionPending = useRef(false);
  const context = useMemo(() => ({ css: siteFields.css.source, js: siteFields.js.source }), [siteFields.css.source, siteFields.js.source]);
  const [operationError, setOperationError] = useState("");
  const [modal, setModal] = useState<{ title: string; code: string } | null>(null);
  const [selected, setSelected] = useState<{ blockId: string; entityId: string; revision: number } | null>(null);
  const videos = useMemo(() => videoPreviewEntries(blocks), [blocks]);
  const [videoModalKey, setVideoModalKey] = useState<string | null>(null);
  const [videoTrigger, setVideoTrigger] = useState<HTMLElement | null>(null);
  const modalVideo = videos.find(entry => entry.key === videoModalKey);
  const selectedVideoKey = videos.find(entry => entry.blockId === selected?.blockId &&
    (entry.entity.id === selected.entityId || entry.relatedEntityIds.includes(selected.entityId)))?.key ?? videos[0]?.key;
  const closeVideoModal = useCallback(() => setVideoModalKey(null), [setVideoModalKey]);
  const selectVideo = useCallback((blockId: string, entityId: string) => {
    setSelected(current => current?.blockId === blockId && current.entityId === entityId
      ? current : { blockId, entityId, revision: (current?.revision ?? 0) + 1 });
  }, []);
  const [sliderPositions, setSliderPositions] = useState<SliderPosition[]>([]);
  const [viewportId, setViewportId] = useState(DEFAULT_PREVIEW_VIEWPORT_ID);
  const [previewScale, setPreviewScale] = useState(1);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const viewport = previewViewportById(viewportId);
  const preview = useMemo(() => {
    const instanceId = crypto.randomUUID();
    try { return { ...buildLivePreview(blocks, context, instanceId), instanceId, error: "" }; }
    catch (error) { return { source: "", registry: new Map(), runtimeBlocks: [], instanceId, error: error instanceof Error ? error.message : "Не удалось собрать Preview." }; }
  }, [blocks, context]);

  const send = useCallback((command: PreviewCommand) => {
    sendPreviewCommand(iframeRef.current?.contentWindow ?? null, preview.instanceId, command);
  }, [preview.instanceId]);

  useEffect(() => {
    function receive(event: MessageEvent) {
      const payload = validatePreviewMessage(event, iframeRef.current?.contentWindow, preview.instanceId, preview.registry);
      if (!payload) return;
      if (payload.type === "select") setSelected(current => ({ ...payload, revision: (current?.revision ?? 0) + 1 }));
      if (payload.type === "sliders") setSliderPositions(payload.sliders);
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [preview.instanceId, preview.registry]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    function resize() {
      if (!stage) return;
      setPreviewScale(calculatePreviewScale(Math.max(stage.clientWidth - 128, 0), Math.max(stage.clientHeight - 24, 0), viewport.width, viewport.height));
    }
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [viewport.width, viewport.height]);

  useEffect(() => {
    if (!modal) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setModal(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [modal]);

  function changeBlock(next: BlockSource) {
    const nextBlocks = blocks.map(block => block.id === next.id ? next : block);
    const hadSource = blocks.some(block => block.fragments.some(fragment => fragment.loaded));
    const hasSource = nextBlocks.some(block => block.fragments.some(fragment => fragment.loaded));
    const transition = advanceSiteComposition(hadSource, hasSource, newCompositionPending.current, siteFields);
    newCompositionPending.current = transition.pending;
    if (transition.fields !== siteFields) setSiteFields(transition.fields);
    setBlocks(nextBlocks);
    setOperationError("");
  }
  function structuralChange(block: BlockSource, update: (committed: BlockSource) => BlockSource) {
    try {
      if (blockHasInvalidContent(block)) throw new Error("Исправьте изменение форматирования или нажмите «Сбросить».");
      changeBlock(update(commitBlockEdits(block)));
    }
    catch (error) { setOperationError(error instanceof Error ? error.message : "Не удалось применить изменения."); }
  }
  const hasSource = blocks.some(block => block.fragments.some(fragment => fragment.loaded));
  const validSliders = sliderPositions.filter(position => preview.registry.get(position.blockId)?.widgets.has(position.widgetGroupId));

  return (
    <main className={styles.page} data-ui-theme="editor">
      <section className={styles.hero}>
        <h1>HTML Content Editor</h1>
        <p>Редактируйте тексты, ссылки и изображения прямо в браузере.</p>
        <p className={styles.localNote}>Загружайте блоки в том порядке, в котором они расположены на странице. Общие стили и скрипты страницы или сайта загружайте отдельно.</p>
      </section>
      <section className={styles.codeLoaderGrid} aria-label="Загрузка кода">
        <div className={styles.blockStack}>
          {blocks.map((block, blockIndex) => (
            <article className={`${styles.codePanel} ${styles.blockCodePanel}`} key={block.id}>
              <div className={styles.codePanelHeader}><span><small>КОД ДЛЯ БЛОКА · БЛОК {blockIndex + 1}</small><strong>Загрузите HTML, CSS и JS код, относящийся к данному блоку.</strong></span></div>
              {block.fragments.map((fragment, fragmentIndex) => {
                return (
                  <div className={styles.codeField} key={fragment.id}>
                    <div className={styles.fragmentHeader}>
                      <label htmlFor={fragment.id}>{fragmentIndex === 0 ? "Основной код" : `Дополнительный код ${fragmentIndex + 1}`}</label>
                      <button type="button" className={styles.iconMenuButton} aria-label="Переместить код вверх" disabled={fragmentIndex === 0} onClick={() => structuralChange(block, committed => reorderFragments(committed, fragment.id, -1))}>↑</button>
                      <button type="button" className={styles.iconMenuButton} aria-label="Переместить код вниз" disabled={fragmentIndex === block.fragments.length - 1} onClick={() => structuralChange(block, committed => reorderFragments(committed, fragment.id, 1))}>↓</button>
                    </div>
                    <textarea id={fragment.id} className={styles.compactCodeInput} value={fragment.loaded ? fragment.source : fragment.draft} spellCheck={false} readOnly={fragment.loaded} rows={5} onChange={event => changeBlock({ ...block, fragments: block.fragments.map(item => item.id === fragment.id ? { ...item, draft: event.target.value } : item) })} />
                    <div className={styles.codeActionRow}>
                      {fragment.loaded ? <>
                        <button type="button" className={styles.secondaryButton} onClick={() => structuralChange(block, committed => ({ ...committed, fragments: committed.fragments.map(item => item.id === fragment.id ? { ...item, source: "", draft: "", loaded: false } : item) }))}>Загрузить другой код</button>
                        <button type="button" className={styles.secondaryButton} onClick={() => setModal({ title: `Блок ${blockIndex + 1} · Код ${fragmentIndex + 1}`, code: editedBlockFragments(block).find(item => item.id === fragment.id)?.source ?? fragment.source })}>Посмотреть код</button>
                      </> : <button type="button" className={styles.primaryButton} disabled={!fragment.draft.trim()} onClick={() => structuralChange(block, committed => ({ ...committed, fragments: committed.fragments.map(item => item.id === fragment.id ? { ...item, source: item.draft, originalSource: item.draft, loaded: true } : item) }))}>Загрузить код</button>}
                      <button type="button" className={`${styles.codeIconButton} ${styles.dangerIconButton}`} title="Удалить этот код" aria-label="Удалить этот код" onClick={() => structuralChange(block, committed => ({ ...committed, fragments: committed.fragments.length === 1 ? [createSourceFragment(fragment.id)] : committed.fragments.filter(item => item.id !== fragment.id) }))}><CodeTrashIcon /></button>
                    </div>
                  </div>
                );
              })}
              <div className={styles.codeActionRow}>
                <button type="button" className={styles.addCodeButton} onClick={() => structuralChange(block, committed => ({ ...committed, fragments: [...committed.fragments, createSourceFragment(`${block.id}-fragment-${nextId.current++}`)] }))}>+ ДОБАВИТЬ КОД К БЛОКУ</button>
              </div>
            </article>
          ))}
          <button type="button" className={styles.addCodeButton} onClick={() => { setBlocks(current => [...current, createBlockSource(`block-${nextId.current++}`)]); setOperationError(""); }}>+ ДОБАВИТЬ БЛОК</button>
        </div>
        <article className={`${styles.codePanel} ${styles.contextCodePanel}`}>
          <div className={styles.codePanelHeader}><span><small>КОНТЕКСТ САЙТА</small><strong>Общие стили и JS для всех блоков.</strong></span></div>
          {(["css", "js"] as const).map(role => {
            const field = siteFields[role];
            const label = role === "css" ? "ОБЩИЕ СТИЛИ САЙТА · CSS" : "ОБЩИЙ JS САЙТА";
            const action = (type: "load" | "replace" | "delete" | "lock") => {
              setSiteFields(current => ({ ...current, [role]: updateSiteCodeField(current[role], type) }));
              setOperationError("");
            };
            return <div className={styles.codeField} key={role}>
              <label htmlFor={"site-" + role}>{label}</label>
              <textarea id={"site-" + role} className={styles.compactCodeInput} value={field.loaded ? field.source : field.draft} readOnly={field.loaded} spellCheck={false} rows={5} onChange={event => setSiteFields(current => ({ ...current, [role]: { ...current[role], draft: event.target.value } }))} />
              <div className={styles.codeActionRow}>
                {field.loaded ? <>
                  <button type="button" className={styles.secondaryButton} onClick={() => action("replace")}>Загрузить другой код</button>
                  <button type="button" className={styles.secondaryButton} onClick={() => setModal({ title: label, code: field.source })}>Посмотреть код</button>
                  <button type="button" className={[styles.codeIconButton, field.locked ? styles.lockButtonActive : ""].join(" ")} aria-pressed={field.locked} aria-label={(field.locked ? "Открепить " : "Закрепить ") + role.toUpperCase()} title={field.locked ? "Переносить между композициями" : "Только для текущей композиции"} onClick={() => action("lock")}><CodeLockIcon locked={field.locked} /></button>
                  <button type="button" className={`${styles.codeIconButton} ${styles.dangerIconButton}`} aria-label={"Удалить " + role.toUpperCase()} title="Удалить код" onClick={() => action("delete")}><CodeTrashIcon /></button>
                </> : <button type="button" className={styles.primaryButton} disabled={!field.draft.trim()} onClick={() => action("load")}>Загрузить код</button>}
              </div>
            </div>;
          })}
        </article>
      </section>
      {operationError ? <p className={styles.errorState} role="alert">{operationError}</p> : null}
      <section className={styles.workspace} aria-label="Редактор HTML-блоков">
        <div className={styles.rightPreviewColumn}>
        <div className={styles.previewPanel}>
          <div className={styles.panelHeader}><strong>Предпросмотр · {viewport.width} × {viewport.height} · {Math.round(previewScale * 100)}%</strong></div>
          <div className={styles.previewPresets} aria-label="Размер предпросмотра">{PREVIEW_VIEWPORTS.map(preset => <button type="button" key={preset.id} aria-pressed={preset.id === viewport.id} onClick={() => { setViewportId(preset.id); send({ type: "scroll-top" }); }}><span>{preset.shortLabel}</span><small>{preset.width}</small></button>)}</div>
          <div className={styles.previewFrame} ref={stageRef}>
            {hasSource && !preview.error ? <div className={styles.previewScreenShell} style={{ "--preview-scale": previewScale, "--preview-width": `${viewport.width}px`, "--preview-height": `${viewport.height}px` } as CSSProperties}>
              <div className={styles.previewViewport}><iframe key={preview.instanceId} ref={iframeRef} title="Предпросмотр HTML-блоков" srcDoc={preview.source} sandbox="allow-scripts" /></div>
              {validSliders.map(position => <div className={styles.externalSliderArrows} key={`${position.blockId}:${position.widgetGroupId}`} style={{ top: position.top * previewScale }}>
                <button type="button" aria-label="Предыдущий слайд" disabled={!position.canPrev} onClick={() => send({ type: "slide", blockId: position.blockId, widgetGroupId: position.widgetGroupId, index: Math.max(position.index - 1, 0) })}>←</button>
                <button type="button" aria-label="Следующий слайд" disabled={!position.canNext} onClick={() => send({ type: "slide", blockId: position.blockId, widgetGroupId: position.widgetGroupId, index: position.index + 1 })}>→</button>
              </div>)}
            </div> : <p className={preview.error ? styles.errorState : styles.emptyState}>{preview.error || "После загрузки кода здесь появится Preview."}</p>}
          </div>
        </div>
        {videos.length ? <VideoGallery entries={videos} selectedKey={selectedVideoKey} onOpen={(entry, trigger) => {
          setVideoTrigger(trigger);
          selectVideo(entry.blockId, entry.entity.id); setModal(null); setVideoModalKey(entry.key);
        }} /> : null}
        </div>
        <div className={styles.blockStack}>{blocks.map((block, index) => <BlockFields key={block.id} block={block} index={index} selected={selected} onChange={changeBlock} send={send} onSelectVideo={selectVideo} />)}</div>
      </section>
      {modalVideo ? <VideoModal key={`${modalVideo.key}:${modalVideo.source}`} entry={modalVideo} trigger={videoTrigger} onClose={closeVideoModal} /> : null}
      {modal ? createPortal(<div className={styles.modalBackdrop} data-ui-theme="editor" onClick={() => setModal(null)}><section className={styles.codeModal} role="dialog" aria-modal="true" aria-label={modal.title} onClick={event => event.stopPropagation()}><h2>{modal.title}</h2><button type="button" className={styles.secondaryButton} onClick={() => setModal(null)}>Закрыть</button><pre className={styles.outputCode}>{modal.code}</pre></section></div>, document.body) : null}
    </main>
  );
}
