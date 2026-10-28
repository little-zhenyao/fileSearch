import { useCallback, useRef, useState } from "react";
import {
  api,
  type Group,
  type SearchContext,
  type SearchResponse,
} from "./types";

export const emptySearch: SearchContext = {
  query: "",
  mode: "all",
  course: "",
  category: "",
  document: "",
  expand: false,
  sort: "relevance",
};
export function searchParams(context: SearchContext) {
  const params = new URLSearchParams({
    q: context.query,
    mode: context.mode,
    expand: String(context.expand),
    sort: context.sort,
  });
  if (context.course) params.set("course_id", context.course);
  if (context.category) params.set("category", context.category);
  if (context.document) params.set("document_id", context.document);
  return params;
}

export function useSearch(onError: (message: string) => void) {
  const [draft, setDraft] = useState<SearchContext>(emptySearch);
  const [context, setContext] = useState<SearchContext | null>(null);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const pendingUnits = useRef(new Set<string>());
  const contextRef = useRef(context);
  contextRef.current = context;

  const execute = useCallback(
    async (next: SearchContext, append = false, record = true) => {
      if (!next.query.trim()) return;
      const normalized = { ...emptySearch, ...next, query: next.query.trim() };
      const token = ++generation.current;
      const params = searchParams(normalized);
      if (append && response?.next_offset != null)
        params.set("offset", String(response.next_offset));
      if (!append) {
        setResponse(null);
        setDraft(normalized);
        setContext(normalized);
      }
      setLoading(true);
      try {
        const result = await api<SearchResponse>(`/search?${params}`);
        if (token !== generation.current) return;
        setResponse((previous) =>
          append && previous
            ? { ...result, groups: [...previous.groups, ...result.groups] }
            : result,
        );
        if (record && !append)
          await api("/history", {
            method: "POST",
            body: JSON.stringify(normalized),
          });
      } catch (reason) {
        if (token === generation.current) onError((reason as Error).message);
      } finally {
        if (token === generation.current) setLoading(false);
      }
    },
    [response?.next_offset, onError],
  );

  const loadUnits = async (group: Group) => {
    const search = contextRef.current;
    if (!search || group.next_unit_offset == null) return;
    const token = generation.current;
    const offset = group.next_unit_offset;
    const requestKey = `${token}:${group.document_id}:${offset}`;
    if (pendingUnits.current.has(requestKey)) return;
    pendingUnits.current.add(requestKey);
    const params = searchParams({ ...search, document: group.document_id });
    params.set("unit_offset", String(offset));
    try {
      const result = await api<SearchResponse>(`/search?${params}`);
      if (token !== generation.current || !result.groups[0]) return;
      const added = result.groups[0];
      setResponse(
        (previous) =>
          previous && {
            ...previous,
            groups: previous.groups.map((item) =>
              item.document_id === group.document_id &&
              item.next_unit_offset === offset
                ? { ...added, hits: [...item.hits, ...added.hits] }
                : item,
            ),
          },
      );
    } catch (reason) {
      if (token === generation.current) onError((reason as Error).message);
    } finally {
      pendingUnits.current.delete(requestKey);
    }
  };
  const clear = useCallback(() => {
    generation.current++;
    setContext(null);
    setResponse(null);
    setLoading(false);
  }, []);
  return {
    draft,
    setDraft,
    context,
    response,
    loading,
    execute,
    loadUnits,
    clear,
  };
}
