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
