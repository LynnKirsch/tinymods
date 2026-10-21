import type { EditableEntity, ImageEntityKind } from "./types";

export type ImageGroupItem = {
  entity: EditableEntity & { kind: ImageEntityKind };
  label: string;
  detail: string;
};

export type ImageAltStatus = "filled" | "empty" | "missing";

export type ImageGroup = {
  id: string;
  title: string;
  items: ImageGroupItem[];
  altEntity?: EditableEntity & { kind: "alt" };
  altStatus?: ImageAltStatus;
};

function isImageKind(kind: EditableEntity["kind"]): kind is ImageEntityKind {
  return (
    kind === "src" ||
    kind === "srcset" ||
    kind === "poster" ||
    kind === "background-image"
  );
}

export function isImageEntity(
  entity: EditableEntity,
): entity is EditableEntity & { kind: ImageEntityKind } {
  return isImageKind(entity.kind);
}

function isAltEntity(entity: EditableEntity): entity is EditableEntity & { kind: "alt" } {
  return entity.kind === "alt";
}

export function isVideoEntity(entity: EditableEntity) {
  return entity.context.type === "attribute" && entity.context.mediaRole === "video";
}

function storyPosters(entities: EditableEntity[], mediaGroupId: string) {
  return entities.filter(candidate => candidate.kind === "poster" &&
    candidate.context.type === "attribute" && candidate.context.mediaRole === "video-poster" &&
    candidate.context.mediaGroupId === mediaGroupId);
}

export function linkedVideoEntities(entities: EditableEntity[], entity: EditableEntity) {
  const context = entity.context;
  if (context.type !== "attribute" || !context.mediaGroupId) return [entity];
  if (entity.kind === "poster" && context.mediaRole === "video-poster") {
    const posters = storyPosters(entities, context.mediaGroupId);
    // Conflicting explicit posters are independent; never guess which one is authoritative.
    return posters.length > 1 && posters.every(poster => poster.displayValue === entity.displayValue)
      ? posters : [entity];
  }
  if (context.name !== "data-video") return [entity];
  return entities.filter(candidate => candidate.context.type === "attribute" &&
    candidate.context.name === "data-video" && candidate.context.mediaRole === "video" &&
    candidate.context.mediaGroupId === context.mediaGroupId);
}

export function videoPosterEntity(entities: EditableEntity[], video: EditableEntity) {
  if (video.context.type !== "attribute" || !video.context.mediaGroupId) return undefined;
  const posters = storyPosters(entities, video.context.mediaGroupId);
  return posters.length && posters.every(poster => poster.displayValue === posters[0].displayValue)
    ? posters[0] : undefined;
}

export function isImageGroupEntity(entity: EditableEntity) {
  return isImageEntity(entity) || isAltEntity(entity);
}

export function usesImageMetadata(entity: EditableEntity) {
  if (!isImageEntity(entity)) return false;
  if (entity.context.type === "attribute" && entity.context.mediaRole === "video") return false;
  return true;
}

function imageFormatLabel(value?: string) {
  if (value === "image/avif") return "AVIF";
  if (value === "image/webp") return "WebP";
  if (value === "video/mp4") return "MP4";
  if (value === "video/webm") return "WebM";
  if (value === "video/ogg") return "OGG";
  if (value?.startsWith("video/")) return value.replace(/^video\//, "").toUpperCase();
  return value?.replace(/^image\//, "").toUpperCase() || "";
}

function mediaLabel(value?: string) {
  const maxWidth = value?.match(/max-width:\s*(\d+)px/i)?.[1];
  if (maxWidth) return `до ${maxWidth} px`;
  return value ?? "";
}

function viewportMediaLabel(value?: string) {
  if (!value) return "Все экраны";
  const minWidth = value.match(/min-width:\s*(\d+)px/i)?.[1];
  const maxWidth = value.match(/max-width:\s*(\d+)px/i)?.[1];
  if (minWidth && maxWidth) return `${minWidth}–${maxWidth} px`;
  if (maxWidth) return `До ${maxWidth} px`;
  if (minWidth) return `От ${minWidth} px`;
  return `Условие: ${value.replace(/[()]/g, "").trim()}`;
}

function imageItemLabel(entity: EditableEntity & { kind: ImageEntityKind }) {
  if (entity.context.type === "css-url") return "Фоновое изображение";
  if (entity.kind === "poster" || (entity.context.type === "attribute" && entity.context.mediaRole === "video-poster")) return "Постер к видео";
  if (entity.context.type === "attribute" && entity.context.mediaRole === "video") {
    return viewportMediaLabel(entity.context.media);
  }
  if (entity.context.type === "attribute" && entity.context.fallback) return "Основное изображение";
  if (entity.context.type === "srcset-url") {
    return imageFormatLabel(entity.context.sourceType) || "Вариант изображения";
  }
  return "Изображение";
}

function imageItemDetail(entity: EditableEntity & { kind: ImageEntityKind }) {
  if (entity.context.type === "attribute" && entity.context.mediaRole === "video") {
    return imageFormatLabel(entity.context.sourceType);
  }
  if (entity.context.type === "srcset-url") {
    return [mediaLabel(entity.context.media), entity.context.descriptor]
      .filter(Boolean)
      .join(" · ");
  }
  if (entity.context.type === "css-url") {
    return entity.context.container === "style-block" ? "CSS background-image" : "inline background-image";
  }
  if (entity.context.type === "attribute" && entity.context.mediaRole === "video") {
    return "video src";
  }
  return "";
}

function imageGroupId(entity: EditableEntity & { kind: ImageEntityKind }, entities: EditableEntity[]) {
  if (entity.kind === "poster") {
    return `poster:${linkedVideoEntities(entities, entity)[0].id}`;
  }
  if (
    (entity.context.type === "srcset-url" || entity.context.type === "attribute") &&
    entity.context.mediaGroupId
  ) {
    return entity.context.mediaGroupId;
  }
  if (entity.context.type === "srcset-url" && entity.context.pictureId) {
    return entity.context.pictureId;
  }
  if (entity.context.type === "attribute" && entity.context.pictureId) {
    return entity.context.pictureId;
  }
  return `image:${entity.id}`;
}

function altGroupId(entity: EditableEntity & { kind: "alt" }) {
  if (entity.context.type === "attribute" && entity.context.mediaGroupId) {
    return entity.context.mediaGroupId;
  }
  if (entity.context.type === "attribute" && entity.context.pictureId) {
    return entity.context.pictureId;
  }
  return `image:${entity.id}`;
}

function imageGroupTitle(entity: EditableEntity & { kind: ImageEntityKind }) {
  if (entity.kind === "poster" || ((entity.context.type === "attribute" || entity.context.type === "srcset-url") && entity.context.mediaRole === "video-poster")) return "Постер к видео";
  if (entity.context.type === "css-url") return "Фоновое изображение";
  if (
    (entity.context.type === "srcset-url" || entity.context.type === "attribute") &&
    entity.context.mediaRole === "video"
  ) {
    return "Видео";
  }
  if (
    (entity.context.type === "srcset-url" || entity.context.type === "attribute") &&
    entity.context.pictureId
  ) {
    return "Медиа";
  }
  return "Медиа";
}

function altStatus(entity: EditableEntity & { kind: "alt" }): ImageAltStatus {
  if (entity.context.type === "attribute" && entity.context.missing) return "missing";
  return entity.rawValue.length > 0 ? "filled" : "empty";
}

export function groupImageEntities(entities: EditableEntity[]) {
  const groups = new Map<string, ImageGroup>();

  for (const entity of entities) {
    if (isAltEntity(entity)) {
      const groupId = altGroupId(entity);
      const group = groups.get(groupId) ?? {
        id: groupId,
        title: "Медиа",
        items: [],
      };
      group.altEntity = entity;
      group.altStatus = altStatus(entity);
      groups.set(groupId, group);
      continue;
    }

    if (!isImageEntity(entity)) continue;

    const groupId = imageGroupId(entity, entities);
    const group = groups.get(groupId) ?? {
      id: groupId,
      title: imageGroupTitle(entity),
      items: [],
    };
    // Linked custom video attributes remain separate entities/ranges for patching,
    // but their shared media group exposes one editable URL.
    if (entity.context.type === "attribute" && (entity.context.name === "data-video" || entity.kind === "poster") && group.items.length) continue;
    group.items.push({
      entity,
      label: imageItemLabel(entity),
      detail: imageItemDetail(entity),
    });
    groups.set(groupId, group);
  }

  return [...groups.values()];
}
