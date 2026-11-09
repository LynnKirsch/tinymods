export type SliderPosition = {
  blockId: string;
  widgetGroupId: string;
  top: number;
  index: number;
  count: number;
  canPrev: boolean;
  canNext: boolean;
};

export type PreviewEvent =
  | { type: "ready" }
  | { type: "select"; blockId: string; entityId: string }
  | { type: "sliders"; sliders: SliderPosition[] };

export type PreviewCommand =
  | { type: "highlight"; markerIds: string[] }
  | { type: "slide"; blockId: string; widgetGroupId: string; index: number }
  | { type: "reveal"; blockId: string; entityId: string }
  | { type: "scroll-top" };

export type PreviewEnvelope = { channel: "tinymods-preview"; instanceId: string; payload: PreviewEvent };
export type PreviewRegistry = Map<string, { entityIds: Set<string>; widgets: Map<string, number> }>;

export function validatePreviewMessage(
  event: { source: unknown; data: unknown }, expectedWindow: unknown, instanceId: string, registry: PreviewRegistry,
): PreviewEvent | null {
  if (!expectedWindow || event.source !== expectedWindow || !event.data || typeof event.data !== "object") return null;
  const message = event.data as Partial<PreviewEnvelope>;
  if (message.channel !== "tinymods-preview" || message.instanceId !== instanceId || !message.payload || typeof message.payload !== "object") return null;
  const payload = message.payload;
  if (payload.type === "ready") return payload;
  if (payload.type === "select") {
    return typeof payload.blockId === "string" && typeof payload.entityId === "string" &&
      registry.get(payload.blockId)?.entityIds.has(payload.entityId) ? payload : null;
  }
  if (payload.type === "sliders" && Array.isArray(payload.sliders) && payload.sliders.length <= 500) {
    const seen = new Set<string>();
    for (const item of payload.sliders) {
      if (!item || typeof item !== "object" || typeof item.blockId !== "string" || typeof item.widgetGroupId !== "string") return null;
      const count = registry.get(item.blockId)?.widgets.get(item.widgetGroupId);
      const key = `${item.blockId}::${item.widgetGroupId}`;
      if (!count || count !== item.count || seen.has(key) || typeof item.canPrev !== "boolean" || typeof item.canNext !== "boolean" || !Number.isFinite(item.top) || Math.abs(item.top) > 1e7 ||
        !Number.isInteger(item.index) || item.index < 0 || item.index >= count) return null;
      seen.add(key);
    }
    return payload;
  }
  return null;
}

export function sendPreviewCommand(target: Pick<Window, "postMessage"> | null, instanceId: string, payload: PreviewCommand) {
  target?.postMessage({ channel: "tinymods-preview-command", instanceId, payload }, "*");
}
