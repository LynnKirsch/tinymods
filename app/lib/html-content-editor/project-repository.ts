import type { EditorWorkspaceContext } from "./editor-workspace-context";

export type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateProjectInput = {
  name: string;
};

export type UpdateProjectInput = {
  name: string;
};

export type ProjectPage = {
  id: string;
  projectId: string;
  name: string;
  path?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateProjectPageInput = {
  projectId: string;
  name: string;
  path?: string;
};

export type StyleScope = "site" | "page";

export type StyleRevision = {
  id: string;
  scope: StyleScope;
  projectId: string;
  pageId?: string;
  css: string;
  createdAt: string;
};

export type SiteAppearance = {
  projectId: string;
  css: string;
  updatedAt: string;
  currentRevisionId: string;
};

export type PageAppearance = {
  pageId: string;
  projectId: string;
  css: string;
  updatedAt: string;
  currentRevisionId: string;
};

export type ActiveProjectContext = {
  projectId: string | null;
  pageId: string | null;
};

export type ProjectRepository = {
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  createProject(input: CreateProjectInput): Promise<Project>;
  updateProject(id: string, input: UpdateProjectInput): Promise<Project>;
  deleteProject(id: string): Promise<void>;

  listProjectPages(projectId: string): Promise<ProjectPage[]>;
  createProjectPage(input: CreateProjectPageInput): Promise<ProjectPage>;

  getActiveContext(): Promise<ActiveProjectContext>;
  setActiveContext(context: ActiveProjectContext): Promise<void>;

  getSiteAppearance(projectId: string): Promise<SiteAppearance | null>;
  saveSiteAppearance(projectId: string, css: string): Promise<SiteAppearance>;
  clearSiteAppearance(projectId: string): Promise<void>;
  listSiteStyleRevisions(projectId: string): Promise<StyleRevision[]>;
  restoreSiteStyleRevision(projectId: string, revisionId: string): Promise<SiteAppearance>;

  getEditorWorkspaceContext(): Promise<EditorWorkspaceContext>;
  saveEditorWorkspaceContext(context: EditorWorkspaceContext): Promise<EditorWorkspaceContext>;

  getPageAppearance(pageId: string): Promise<PageAppearance | null>;
  savePageAppearance(projectId: string, pageId: string, css: string): Promise<PageAppearance>;
  listPageStyleRevisions(pageId: string): Promise<StyleRevision[]>;
};

export type FutureProjectBlock = {
  id: string;
  projectId: string;
  pageId: string;
  name: string;
  source: string;
  createdAt: string;
  updatedAt: string;
};

/*
Current storage is browser-backed through BrowserProjectRepository.
The presentation layer depends only on ProjectRepository so a later server adapter
can scope data by User -> Projects without changing editor logic. When auth is
added, passwords must be stored only as hashes; admin help should use roles or
password reset flows, never plaintext password access.
*/
