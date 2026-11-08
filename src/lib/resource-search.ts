/**
 * PCL2 `ResourceSearcher` naming layer.
 *
 * PCL2 models a search as `SearchRequest` + persistent `SearchResult` storage
 * (`CurseForgeOffset/Total`, `ModrinthOffset/Total`, `Results`, `ErrorMessage`).
 * `PageResource.LoaderInput` builds the request with
 * `New SearchRequest(PageType, Storage, (Page + 1) * PAGE_SIZE)` where `Page`
 * is 0-based, so `TargetResultCount` grows with the page the user is on.
 *
 * The UI still uses 1-based `page`/`pageSize` and still replaces its result
 * list on every request — the conversion below keeps that behaviour identical
 * while expressing it with PCL2's names and data structures. `searchContent`
 * arguments and `SearchContentResult` are unchanged.
 */
import { getLoaderName, PAGE_SIZE, type CatalogCategory } from "./resource-catalog";
import { dedupeResults } from "./resource-project";
import type {
  ContentHit,
  ContentProjectType,
  SearchContentResult,
} from "./types";

/** PCL2 `ResourceSearcher.RESULT_PAGE_SIZE` (kept at the launcher's 20). */
export const RESULT_PAGE_SIZE = PAGE_SIZE;

/** PCL2 `ResourcePlatforms`, narrowed to the two catalogues we query. */
export type ResourcePlatform = "Any" | "CurseForge" | "Modrinth";

/** PCL2 `ResourceSearcher.SearchResult`. */
export interface SearchResult {
  Results: ContentHit[];
  ErrorMessage: string | null;
  /** `-1` means "total not known yet", same as PCL2. */
  CurseForgeOffset: number;
  CurseForgeTotal: number;
  ModrinthOffset: number;
  ModrinthTotal: number;
  TranslatedQuery: string | null;
}

export function createSearchResult(): SearchResult {
  return {
    Results: [],
    ErrorMessage: null,
    CurseForgeOffset: 0,
    CurseForgeTotal: -1,
    ModrinthOffset: 0,
    ModrinthTotal: -1,
    TranslatedQuery: null,
  };
}

/** PCL2 `ResourceSearcher.SearchRequest`. */
export interface SearchRequest {
  Type: CatalogCategory;
  ProjectType: ContentProjectType;
  SearchText: string;
  GameVersion?: string;
  ModLoaders?: string;
  Tag: string;
  Sources: ResourcePlatform;
  Storage: SearchResult;
  /** PCL2 `(Page + 1) * PAGE_SIZE`. */
  TargetResultCount: number;
  /** PCL2 `PageResource.Page`, 0-based. */
  Page: number;
  PageSize: number;
  Offset: number;
  Sort?: string;
  LoaderName: string;
}

export interface SearchRequestInput {
  projectType: CatalogCategory;
  wireProjectType: ContentProjectType;
  query: string;
  gameVersion?: string;
  loader?: string;
  sort?: string;
  /** 1-based page as used by the existing UI. */
  page: number;
  pageSize?: number;
  storage?: SearchResult;
}

export function createSearchRequest(input: SearchRequestInput): SearchRequest {
  const pageSize = input.pageSize ?? PAGE_SIZE;
  const page = Math.max(0, Math.trunc(input.page) - 1);
  const isBedrock =
    input.loader === "bedrock" ||
    input.gameVersion === "bedrock" ||
    input.gameVersion === "基岩版" ||
    input.wireProjectType === "world";

  return {
    Type: input.projectType,
    ProjectType: input.wireProjectType,
    SearchText: input.query,
    GameVersion: input.gameVersion,
    ModLoaders: input.loader,
    Tag: "",
    Sources: isBedrock ? "CurseForge" : "Modrinth",
    Storage: input.storage ?? createSearchResult(),
    TargetResultCount: (page + 1) * pageSize,
    Page: page,
    PageSize: pageSize,
    Offset: page * pageSize,
    Sort: input.sort,
    LoaderName: getLoaderName(input.projectType),
  };
}

/** PCL2 `SearchRequest.CanContinue`. */
export function canContinue(result: SearchResult): boolean {
  if (result.CurseForgeTotal === -1 || result.ModrinthTotal === -1) return true;
  return (
    result.CurseForgeOffset < result.CurseForgeTotal ||
    result.ModrinthOffset < result.ModrinthTotal
  );
}

/** Options for the unchanged `searchContent()` IPC wrapper. */
export interface SearchContentOptions {
  query?: string;
  projectType: ContentProjectType;
  gameVersion?: string;
  loader?: string;
  sort?: string;
  offset?: number;
  limit?: number;
}

export function toSearchContentOptions(
  request: SearchRequest,
): SearchContentOptions {
  return {
    query: request.SearchText,
    projectType: request.ProjectType,
    gameVersion: request.GameVersion,
    loader: request.ModLoaders,
    sort: request.Sort,
    offset: request.Offset,
    limit: request.PageSize,
  };
}

/**
 * Fold a backend response into PCL2 `Storage`. PCL2 de-duplicates cross-source
 * projects with `ResourceProject.IsLike` before showing them; we do the same
 * here without changing the response shape.
 */
export function applySearchResponse(
  request: SearchRequest,
  response: SearchContentResult,
): SearchResult {
  const results = dedupeResults(response.hits ?? []);
  const isCurseForge = request.Sources === "CurseForge";
  return {
    ...request.Storage,
    Results: results,
    ErrorMessage: null,
    CurseForgeOffset: isCurseForge
      ? response.offset + results.length
      : request.Storage.CurseForgeOffset,
    CurseForgeTotal: isCurseForge
      ? response.totalHits
      : request.Storage.CurseForgeTotal,
    ModrinthOffset: isCurseForge
      ? request.Storage.ModrinthOffset
      : response.offset + results.length,
    ModrinthTotal: isCurseForge
      ? request.Storage.ModrinthTotal
      : response.totalHits,
    TranslatedQuery: response.translatedQuery ?? null,
  };
}
