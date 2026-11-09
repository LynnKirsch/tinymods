import type {
  ActiveProjectContext,
  CreateProjectInput,
  CreateProjectPageInput,
  Project,
  ProjectPage,
  ProjectRepository,
  StyleRevision,
  UpdateProjectInput,
} from "./project-repository";
import type { EditorWorkspaceContext } from "./editor-workspace-context";

export const PROJECT_STORAGE_KEY = "tinymods.projects.v1";
const SCHEMA_VERSION = 1;

type BrowserStorage = Pick<Storage, "getItem" | "setItem">;

type PersistedProjectState = {
  schemaVersion: 1;
  projects: Project[];
  pages: ProjectPage[];
  styleRevisions: StyleRevision[];
  activeProjectId: string | null;
  activePageId: string | null;
  editorWorkspaceContext: EditorWorkspaceContext;
};

type BrowserProjectRepositoryOptions = {
  storage?: BrowserStorage;
  now?: () => string;
  createId?: () => string;
};

function emptyState(): PersistedProjectState {
  return {
    schemaVersion: SCHEMA_VERSION,
    projects: [],
    pages: [],
    styleRevisions: [],
    activeProjectId: null,
    activePageId: null,
    editorWorkspaceContext: emptyEditorWorkspaceContext(),
  };
}

function emptyEditorWorkspaceContext(): EditorWorkspaceContext {
  return {
    temporarySiteAppearance: null,
    temporaryPageAppearance: null,
    projectPageAppearances: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isProject(value: unknown): value is Project {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isPage(value: unknown): value is ProjectPage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.projectId === "string" &&
    typeof value.name === "string" &&
    (value.path === undefined || typeof value.path === "string") &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isRevision(value: unknown): value is StyleRevision {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.scope === "site" || value.scope === "page") &&
    typeof value.projectId === "string" &&
    (value.pageId === undefined || typeof value.pageId === "string") &&
    typeof value.css === "string" &&
    typeof value.createdAt === "string"
  );
}

function isEditorWorkspaceContext(value: unknown): value is EditorWorkspaceContext {
  return (
    isRecord(value) &&
    (value.temporarySiteAppearance === null ||
      (isRecord(value.temporarySiteAppearance) &&
        typeof value.temporarySiteAppearance.css === "string" &&
        (value.temporarySiteAppearance.updatedAt === null ||
          typeof value.temporarySiteAppearance.updatedAt === "string"))) &&
    (value.temporaryPageAppearance === undefined ||
      value.temporaryPageAppearance === null ||
      (isRecord(value.temporaryPageAppearance) &&
        typeof value.temporaryPageAppearance.css === "string" &&
        (value.temporaryPageAppearance.updatedAt === null ||
          typeof value.temporaryPageAppearance.updatedAt === "string"))) &&
    (value.projectPageAppearances === undefined ||
      (isRecord(value.projectPageAppearances) &&
        Object.values(value.projectPageAppearances).every(
          (appearance) =>
            appearance === null ||
            (isRecord(appearance) &&
              typeof appearance.css === "string" &&
              (appearance.updatedAt === null || typeof appearance.updatedAt === "string")),
        )))
  );
}

function normalizeEditorWorkspaceContext(context: EditorWorkspaceContext): EditorWorkspaceContext {
  return {
    ...emptyEditorWorkspaceContext(),
    ...context,
    projectPageAppearances: context.projectPageAppearances ?? {},
  };
}

export function decodeProjectState(rawValue: string | null): PersistedProjectState {
  if (!rawValue) return emptyState();

  try {
    const parsed = JSON.parse(rawValue);
    if (!isRecord(parsed) || parsed.schemaVersion !== SCHEMA_VERSION) return emptyState();

    return {
      schemaVersion: SCHEMA_VERSION,
      projects: Array.isArray(parsed.projects) ? parsed.projects.filter(isProject) : [],
      pages: Array.isArray(parsed.pages) ? parsed.pages.filter(isPage) : [],
      styleRevisions: Array.isArray(parsed.styleRevisions)
        ? parsed.styleRevisions.filter(isRevision)
        : [],
      activeProjectId:
        typeof parsed.activeProjectId === "string" ? parsed.activeProjectId : null,
      activePageId: typeof parsed.activePageId === "string" ? parsed.activePageId : null,
      editorWorkspaceContext: isEditorWorkspaceContext(parsed.editorWorkspaceContext)
        ? normalizeEditorWorkspaceContext(parsed.editorWorkspaceContext)
        : emptyEditorWorkspaceContext(),
    };
  } catch {
    return emptyState();
  }
}

export function encodeProjectState(state: PersistedProjectState) {
  return JSON.stringify(state);
}

function browserStorage(): BrowserStorage | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage;
}

function defaultId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function latestRevision(revisions: StyleRevision[]) {
  return revisions.at(-1) ?? null;
}

export class BrowserProjectRepository implements ProjectRepository {
  private storage: BrowserStorage | undefined;
  private now: () => string;
  private createId: () => string;

  constructor(options: BrowserProjectRepositoryOptions = {}) {
    this.storage = options.storage ?? browserStorage();
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? defaultId;
  }

  private read() {
    return decodeProjectState(this.storage?.getItem(PROJECT_STORAGE_KEY) ?? null);
  }

  private write(state: PersistedProjectState) {
    this.storage?.setItem(PROJECT_STORAGE_KEY, encodeProjectState(state));
  }

  async listProjects() {
    return [...this.read().projects].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  async getProject(id: string) {
    return this.read().projects.find((project) => project.id === id) ?? null;
  }

  async createProject(input: CreateProjectInput) {
    const name = input.name.trim();
    if (!name) throw new Error("Project name is required");

    const state = this.read();
    const timestamp = this.now();
    const project: Project = {
      id: this.createId(),
      name,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.projects.push(project);
    state.activeProjectId = project.id;
    this.write(state);
    return project;
  }

  async updateProject(id: string, input: UpdateProjectInput) {
    const name = input.name.trim();
    if (!name) throw new Error("Project name is required");

    const state = this.read();
    const project = state.projects.find((item) => item.id === id);
    if (!project) throw new Error("Project not found");
    const updated = { ...project, name, updatedAt: this.now() };
    state.projects = state.projects.map((item) => (item.id === id ? updated : item));
    this.write(state);
    return updated;
  }

  async deleteProject(id: string) {
    const state = this.read();
    state.projects = state.projects.filter((project) => project.id !== id);
    state.pages = state.pages.filter((page) => page.projectId !== id);
    state.styleRevisions = state.styleRevisions.filter((revision) => revision.projectId !== id);
    if (state.activeProjectId === id) {
      state.activeProjectId = state.projects[0]?.id ?? null;
      state.activePageId =
        state.pages.find((page) => page.projectId === state.activeProjectId)?.id ?? null;
    }
    this.write(state);
  }

  async listProjectPages(projectId: string) {
    return this.read()
      .pages.filter((page) => page.projectId === projectId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async createProjectPage(input: CreateProjectPageInput) {
    const name = input.name.trim();
    if (!name) throw new Error("Page name is required");
    const path = input.path?.trim();

    const state = this.read();
    if (!state.projects.some((project) => project.id === input.projectId)) {
      throw new Error("Project not found");
    }
    const timestamp = this.now();
    const page: ProjectPage = {
      id: this.createId(),
      projectId: input.projectId,
      name,
      ...(path ? { path } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.pages.push(page);
    state.activeProjectId = input.projectId;
    state.activePageId = page.id;
    this.write(state);
    return page;
  }

  async getActiveContext() {
    const state = this.read();
    return {
      projectId: state.activeProjectId,
      pageId: state.activePageId,
    };
  }

  async setActiveContext(context: ActiveProjectContext) {
    const state = this.read();
    state.activeProjectId = context.projectId;
    state.activePageId = context.pageId;
    this.write(state);
  }

  async getSiteAppearance(projectId: string) {
    const current = latestRevision(await this.listSiteStyleRevisions(projectId));
    if (!current) return null;
    if (!current.css.trim()) return null;
    return {
      projectId,
      css: current.css,
      updatedAt: current.createdAt,
      currentRevisionId: current.id,
    };
  }

  async saveSiteAppearance(projectId: string, css: string) {
    const state = this.read();
    const revision: StyleRevision = {
      id: this.createId(),
      scope: "site",
      projectId,
      css,
      createdAt: this.now(),
    };
    state.styleRevisions.push(revision);
    this.write(state);
    return {
      projectId,
      css,
      updatedAt: revision.createdAt,
      currentRevisionId: revision.id,
    };
  }

  async clearSiteAppearance(projectId: string) {
    await this.saveSiteAppearance(projectId, "");
  }

  async listSiteStyleRevisions(projectId: string) {
    return this.read().styleRevisions.filter(
      (revision) => revision.scope === "site" && revision.projectId === projectId,
    );
  }

  async getEditorWorkspaceContext() {
    return this.read().editorWorkspaceContext;
  }

  async saveEditorWorkspaceContext(context: EditorWorkspaceContext) {
    const state = this.read();
    state.editorWorkspaceContext = context;
    this.write(state);
    return context;
  }

  async restoreSiteStyleRevision(projectId: string, revisionId: string) {
    const revision = (await this.listSiteStyleRevisions(projectId)).find(
      (item) => item.id === revisionId,
    );
    if (!revision) throw new Error("Revision not found");
    return this.saveSiteAppearance(projectId, revision.css);
  }

  async getPageAppearance(pageId: string) {
    const revisions = await this.listPageStyleRevisions(pageId);
    const current = latestRevision(revisions);
    if (!current?.pageId) return null;
    return {
      pageId: current.pageId,
      projectId: current.projectId,
      css: current.css,
      updatedAt: current.createdAt,
      currentRevisionId: current.id,
    };
  }

  async savePageAppearance(projectId: string, pageId: string, css: string) {
    const state = this.read();
    const revision: StyleRevision = {
      id: this.createId(),
      scope: "page",
      projectId,
      pageId,
      css,
      createdAt: this.now(),
    };
    state.styleRevisions.push(revision);
    this.write(state);
    return {
      projectId,
      pageId,
      css,
      updatedAt: revision.createdAt,
      currentRevisionId: revision.id,
    };
  }

  async listPageStyleRevisions(pageId: string) {
    return this.read().styleRevisions.filter(
      (revision) => revision.scope === "page" && revision.pageId === pageId,
    );
  }
}
