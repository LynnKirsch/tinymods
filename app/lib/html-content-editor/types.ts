export type SourceRange = {
  start: number;
  end: number;
};

export type SourcePatch = SourceRange & {
  replacement: string;
};

export type EditableEntityKind =
  | "text"
  | "href"
  | "src"
  | "srcset"
  | "poster"
  | "background-image"
  | "alt";

export type ImageEntityKind = "src" | "srcset" | "poster" | "background-image";

export type LinkRole = "link" | "button" | "card";

export type EditableEntityContext =
  | {
      type: "text";
      tagName: string;
      linkRole?: LinkRole;
      source?: "html" | "js-template";
      presentationGroupId?: string;
    }
  | {
      type: "attribute";
      name: "href" | "src" | "data-src" | "data-video" | "data-poster" | "srcset" | "poster" | "alt";
      quote: '"' | "'";
      elementName?: "img" | "source" | "video";
      pictureId?: string;
      mediaGroupId?: string;
      mediaRole?: "image" | "video" | "video-poster";
      fallback?: boolean;
      media?: string;
      sourceType?: string;
      missing?: boolean;
      linkRole?: LinkRole;
      source?: "html" | "js-constant";
      constantName?: string;
    }
  | {
      type: "css-url";
      property: "background-image";
      quote: '"' | "'" | "";
      container: "style-attribute" | "style-block";
      attributeQuote?: '"' | "'";
    }
  | {
      type: "srcset-url";
      descriptor: string;
      quote: '"' | "'";
      elementName: "img" | "source";
      pictureId?: string;
      mediaGroupId?: string;
      mediaRole?: "image" | "video" | "video-poster";
      media?: string;
      sourceType?: string;
    };

export type EditableEntity = {
  id: string;
  kind: EditableEntityKind;
  rawValue: string;
  displayValue: string;
  range: SourceRange;
  context: EditableEntityContext;
  composite?: {
    ownerTag: SourceRange;
    segments: Array<{ range: SourceRange; displayValue: string; break?: boolean }>;
  };
};
