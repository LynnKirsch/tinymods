export type TemporarySiteAppearance = {
  css: string;
  updatedAt: string | null;
};

export type EditorWorkspaceContext = {
  temporarySiteAppearance: TemporarySiteAppearance | null;
  temporaryPageAppearance: TemporarySiteAppearance | null;
  projectPageAppearances?: Record<string, TemporarySiteAppearance | null>;
};

export function createEditorWorkspaceContext(): EditorWorkspaceContext {
  return {
    temporarySiteAppearance: null,
    temporaryPageAppearance: null,
    projectPageAppearances: {},
  };
}

export function saveTemporarySiteAppearance(
  context: EditorWorkspaceContext,
  css: string,
  now: () => string = () => new Date().toISOString(),
): EditorWorkspaceContext {
  return {
    ...context,
    temporarySiteAppearance: {
      css,
      updatedAt: now(),
    },
  };
}

export function clearTemporarySiteAppearance(context: EditorWorkspaceContext): EditorWorkspaceContext {
  return {
    ...context,
    temporarySiteAppearance: null,
  };
}

export function temporarySiteCss(context: EditorWorkspaceContext) {
  return context.temporarySiteAppearance?.css.trim() ?? "";
}

export function saveTemporaryPageAppearance(
  context: EditorWorkspaceContext,
  css: string,
  now: () => string = () => new Date().toISOString(),
): EditorWorkspaceContext {
  return {
    ...context,
    temporaryPageAppearance: {
      css,
      updatedAt: now(),
    },
  };
}

export function clearTemporaryPageAppearance(context: EditorWorkspaceContext): EditorWorkspaceContext {
  return {
    ...context,
    temporaryPageAppearance: null,
  };
}

export function temporaryPageCss(context: EditorWorkspaceContext) {
  return context.temporaryPageAppearance?.css.trim() ?? "";
}

export function saveProjectPageAppearance(
  context: EditorWorkspaceContext,
  projectId: string,
  css: string,
  now: () => string = () => new Date().toISOString(),
): EditorWorkspaceContext {
  return {
    ...context,
    projectPageAppearances: {
      ...(context.projectPageAppearances ?? {}),
      [projectId]: {
        css,
        updatedAt: now(),
      },
    },
  };
}

export function clearProjectPageAppearance(
  context: EditorWorkspaceContext,
  projectId: string,
): EditorWorkspaceContext {
  return {
    ...context,
    projectPageAppearances: {
      ...(context.projectPageAppearances ?? {}),
      [projectId]: null,
    },
  };
}

export function projectPageCss(context: EditorWorkspaceContext, projectId: string) {
  return context.projectPageAppearances?.[projectId]?.css.trim() ?? "";
}
