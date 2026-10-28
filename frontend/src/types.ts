export type Range = [number, number];
export type Category = "Lecture" | "Tutorial" | "Summary" | "Other";
export type Mode = "all" | "any" | "phrase";
export interface Course {
  id: string;
  name: string;
  document_count: number;
}
export interface DocumentRecord {
  id: string;
  course_id: string;
  course_name: string;
  name: string;
  relative_path: string;
  content_hash: string;
  kind: "pdf" | "docx";
  category: Category;
  status: string;
  version: number;
  unit_count: number;
  searchable_count: number;
  size: number;
  warning: string;
}
export interface JobItem {
  id: string;
  relative_path: string;
  status: string;
  error?: string;
  document_id?: string;
}
export interface Job {
  id: string;
  course_name: string;
  course_id: string;
  created_at: string;
  items: JobItem[];
  done: boolean;
  completed: number;
  total: number;
}
export interface Hit {
  unit_id: string;
  ordinal: number;
  label: string;
  ranges: Range[];
  lexicon_version?: string | null;
  matches?: MatchDetail[];
  match_count: number;
  version: number;
  snippet: { text: string; prefix: boolean; suffix: boolean; ranges: Range[] };
}
export interface Group {
  document_id: string;
  name: string;
  kind: "pdf" | "docx";
  version: number;
  course_id: string;
  course_name: string;
  category: Category;
  hits: Hit[];
  hit_count: number;
  unit_total: number;
  next_unit_offset: number | null;
}
export interface SearchResponse {
  groups: Group[];
  expansions?: { term: string; source: string }[];
  total_documents: number;
  total_hits: number;
  next_offset: number | null;
}
export interface Anchor {
  type: string;
  page?: number;
  heading?: boolean;
  key?: string;
  table?: string;
  row?: number;
  column?: number;
  colspan?: number;
}
export interface Unit {
  unit_id: string;
  text: string;
  label: string;
  anchor: Anchor;
  ranges: Range[];
  rectangles?: number[][][];
  version: number;
}
export interface PreviewUnit {
  unit_id: string;
  text: string;
  label: string;
  anchor: Anchor;
}
export interface Selection {
  document: DocumentRecord;
  hit?: Hit;
  query?: string;
  mode?: Mode;
  expand?: boolean;
  course?: string;
  position?: ReadingPosition;
  visitId?: string;
}
export interface Stats {
  documents: number;
  units: number;
  searchable_units: number;
  pending: number;
  storage_bytes: number;
  library_path: string;
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("X-Local-Request", "1");
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch("/api" + path, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(
      typeof body?.detail === "string"
        ? body.detail
        : `请求失败 (${response.status})`,
    );
  }
  return response.json();
}

export const statusLabels: Record<string, string> = {
  queued: "等待处理",
  processing: "正在索引",
  ready: "可搜索",
  partial: "部分可搜索",
  no_text: "无可提取文字",
  password_required: "需要密码",
  failed: "处理失败",
  duplicate: "相同内容已存在",
  conflict: "等待确认替换",
  unsupported: "不支持的格式",
};
export function bytes(value: number) {
  return value < 1024 * 1024
    ? `${(value / 1024).toFixed(0)} KB`
    : `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export interface SearchContext {
  query: string;
  mode: Mode;
  course: string;
  category: string;
  document: string;
  expand: boolean;
  sort: "relevance" | "category";
}
export interface ReadingPosition {
  document_id: string;
  content_hash: string;
  page?: number | null;
  key?: string | null;
  unit_id?: string | null;
  text_hash?: string | null;
  hit_unit_id?: string | null;
  hit_page?: number | null;
  hit_key?: string | null;
  hit_text_hash?: string | null;
  lexicon_version?: string | null;
  excerpt?: string;
  label?: string;
  version?: number;
  offset: number;
  horizontal: number;
  zoom: number;
  rotation: 0 | 90 | 180 | 270;
  match: number;
  find: string;
}
export interface MatchDetail {
  term: string;
  source: "original" | "form" | "synonym";
  range: Range;
}
export interface Bookmark {
  id: string;
  document_id: string;
  name: string;
  course_id: string;
  course_name: string;
  position: ReadingPosition;
  status: "resolved" | "stale" | "missing";
  note: string;
  tags: string[];
  updated_at: string;
}
export interface HistoryEntry {
  id: string;
  context: SearchContext;
  updated_at: string;
}
export interface Preferences {
  category_order: Category[];
  shortcuts: Record<
    "search" | "back" | "forward" | "bookmark" | "pane1" | "pane2",
    string
  >;
}
export interface VocabularyEntry {
  id?: string;
  course_id: string | null;
  kind: "form" | "synonym";
  terms: string[];
}
export interface ExamState {
  active: boolean;
  course_id?: string | null;
  entered_at?: string;
}
export interface PreflightIssue {
  name: string;
  message: string;
  job_id?: string;
  item_id?: string;
}
export interface PreflightReport {
  id: string;
  course_id: string | null;
  created_at: string;
  stale?: boolean;
  blockers: PreflightIssue[];
  warnings: PreflightIssue[];
  documents: {
    id: string;
    name: string;
    version: number;
    unit_count: number;
    searchable_count: number;
    indexed_at: string;
    ok: boolean;
  }[];
}
