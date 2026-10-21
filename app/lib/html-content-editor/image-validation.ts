import type { EditableEntity, ImageEntityKind } from "./types";

export type ImageValidationIssue = {
  entityId: string;
  kind: "required-image" | "required-button-link";
  message: string;
};

export const REQUIRED_IMAGE_MESSAGE =
  "Поле медиа не должно быть пустым. Вставьте новую ссылку или верните исходное значение.";
export const REQUIRED_BUTTON_LINK_MESSAGE = "Укажите ссылку для кнопки.";

function isRequiredImageEntity(
  entity: EditableEntity,
): entity is EditableEntity & { kind: ImageEntityKind } {
  return (
    entity.kind === "src" ||
    entity.kind === "srcset" ||
    entity.kind === "poster" ||
    entity.kind === "background-image"
  );
}

export function validateRequiredImageValues(
  entities: EditableEntity[],
  values: Record<string, string>,
): ImageValidationIssue[] {
  const imageIssues = entities
    .filter(isRequiredImageEntity)
    .filter((entity) => (values[entity.id] ?? entity.displayValue).trim().length === 0)
    .map((entity) => ({
      entityId: entity.id,
      kind: "required-image" as const,
      message: REQUIRED_IMAGE_MESSAGE,
    }));

  const buttonLinkIssues = entities
    .filter(
      (entity) =>
        entity.kind === "href" &&
        entity.context.type === "attribute" &&
        entity.context.linkRole === "button",
    )
    .filter((entity) => (values[entity.id] ?? entity.displayValue).trim().length === 0)
    .map((entity) => ({
      entityId: entity.id,
      kind: "required-button-link" as const,
      message: REQUIRED_BUTTON_LINK_MESSAGE,
    }));

  return [...imageIssues, ...buttonLinkIssues];
}
