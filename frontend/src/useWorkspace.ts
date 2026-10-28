import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type DocumentRecord,
  type Hit,
  type ReadingPosition,
  type SearchContext,
  type Selection,
} from "./types";
import { emptySearch } from "./useSearch";

interface Visit {
  id: string;
  documentId: string;
  position?: ReadingPosition;
  hit?: Hit;
  context: SearchContext | null;
}
interface Pane {
  current: Visit | null;
  back: Visit[];
  forward: Visit[];
  saved: Visit | null;
}
interface WorkspaceState {
  panes: [Pane, Pane];
  active: 0 | 1;
  dual: boolean;
  collapsed: boolean;
  search: SearchContext;
}
const blankPane = (): Pane => ({
  current: null,
  back: [],
  forward: [],
  saved: null,
});
const initial = (): WorkspaceState => ({
  panes: [blankPane(), blankPane()],
  active: 0,
  dual: false,
  collapsed: false,
  search: emptySearch,
});
const defaultPosition = (doc: DocumentRecord, hit?: Hit): ReadingPosition => ({
  document_id: doc.id,
  content_hash: doc.content_hash,
  page: doc.kind === "pdf" ? (hit?.ordinal ?? 0) + 1 : undefined,
  unit_id: hit?.unit_id,
  version: doc.version,
  offset: 0,
  horizontal: 0,
  zoom: 1,
  rotation: 0,
  match: 0,
  find: "",
});

export function useWorkspace(
  enabled: boolean,
  documents: DocumentRecord[],
  onError: (message: string) => void,
  restoreSearch: (context: SearchContext) => void,
) {
  const [state, setState] = useState(initial);
  const [ready, setReady] = useState(false);
  const ref = useRef(state);
  const loaded = useRef(false);
  const restoreRef = useRef(restoreSearch);
  restoreRef.current = restoreSearch;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const loadGeneration = useRef<[number, number]>([0, 0]);
  const saveChain = useRef(Promise.resolve());
  const persist = useCallback(() => {
    const snapshot = JSON.stringify(ref.current);
    saveChain.current = saveChain.current
      .catch(() => {})
      .then(async () => {
        await api("/workspace", { method: "PUT", body: snapshot });
      })
      .catch((reason) =>
        onError(`阅读状态保存失败：${(reason as Error).message}`),
      );
  }, [onError]);
  const commit = useCallback(
    (next: WorkspaceState, immediate = false) => {
      ref.current = next;
      setState(next);
      clearTimeout(saveTimer.current);
      if (loaded.current) {
        if (immediate) persist();
        else saveTimer.current = setTimeout(persist, 450);
      }
    },
    [persist],
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void api<Partial<WorkspaceState>>("/workspace")
      .then(async (value) => {
        const saved =
          value.panes?.length === 2
            ? ({ ...initial(), ...value } as WorkspaceState)
            : initial();
        saved.active = saved.active === 1 && saved.dual ? 1 : 0;
        for (const pane of saved.panes) {
          if (!pane.current?.position) continue;
          const resolved = await api<{
            status: string;
            position: ReadingPosition;
          }>("/positions/resolve", {
            method: "POST",
            body: JSON.stringify(pane.current.position),
          });
          if (resolved.status === "resolved") {
            pane.current = {
              ...pane.current,
              position: resolved.position,
              id: crypto.randomUUID(),
              hit: undefined,
            };
          } else {
            pane.saved = pane.current;
            pane.current = null;
            onError("上次阅读的资料已变化，位置待确认；可从资料列表重新打开。");
          }
        }
        if (cancelled) return;
        ref.current = saved;
        setState(saved);
        loaded.current = true;
        setReady(true);
        if (saved.search.query) restoreRef.current(saved.search);
        else restoreRef.current({ ...emptySearch, ...saved.search });
      })
      .catch((reason) => {
        if (!cancelled) {
          onError((reason as Error).message);
          loaded.current = true;
          setReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, onError]);

  useEffect(() => {
    const flush = () => {
      if (loaded.current) {
        clearTimeout(saveTimer.current);
        // keepalive survives a refresh; regular saves are serialized above.
        void api("/workspace", {
          method: "PUT",
          body: JSON.stringify(ref.current),
          keepalive: true,
        }).catch(() => {});
      }
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      clearTimeout(saveTimer.current);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);

  const updatePosition = useCallback(
    (paneId: 0 | 1, visitId: string, position: ReadingPosition) => {
      const previous = ref.current;
      const pane = previous.panes[paneId];
      if (!pane.current || pane.current.id !== visitId) return;
      const panes = [...previous.panes] as [Pane, Pane];
      panes[paneId] = { ...pane, current: { ...pane.current, position } };
      commit({ ...previous, panes });
    },
    [commit],
  );

  const open = useCallback(
    (
      doc: DocumentRecord,
      context: SearchContext | null,
      hit?: Hit,
      paneId?: 0 | 1,
      position?: ReadingPosition,
    ) => {
      const previous = ref.current;
      const target = paneId ?? previous.active;
      loadGeneration.current[target]++;
      const pane = previous.panes[target];
      const panes = [...previous.panes] as [Pane, Pane];
      panes[target] = {
        ...pane,
        back: pane.current
          ? [...pane.back, pane.current].slice(-100)
          : pane.back,
        forward: [],
        current: {
          id: crypto.randomUUID(),
          documentId: doc.id,
          context,
          hit,
          position: position ?? defaultPosition(doc, hit),
        },
      };
      commit(
        {
          ...previous,
          panes,
          active: target,
          dual: previous.dual || target === 1,
        },
        true,
      );
    },
    [commit],
  );

  const travel = useCallback(
    async (direction: "back" | "forward") => {
      const previous = ref.current,
        target = previous.active,
        pane = previous.panes[target];
      const stack = pane[direction];
      const visit = stack.at(-1);
      if (!visit?.position) return;
      const token = ++loadGeneration.current[target];
      try {
        const resolved = await api<{
          status: string;
          position: ReadingPosition;
        }>("/positions/resolve", {
          method: "POST",
          body: JSON.stringify(visit.position),
        });
        if (resolved.status !== "resolved")
          throw new Error(
            "资料已变化，此历史位置待确认。请从资料列表重新打开。",
          );
        if (
          token !== loadGeneration.current[target] ||
          ref.current.panes[target].current?.id !== pane.current?.id
        )
          return;
        const latest = ref.current;
        const latestPane = latest.panes[target];
        const opposite = direction === "back" ? "forward" : "back";
        const panes = [...latest.panes] as [Pane, Pane];
        panes[target] = {
          ...latestPane,
          [direction]: stack.slice(0, -1),
          [opposite]: latestPane.current
            ? [...latestPane[opposite], latestPane.current].slice(-100)
            : latestPane[opposite],
          current: {
            ...visit,
            id: crypto.randomUUID(),
            position: resolved.position,
            hit: undefined,
          },
        };
        commit(
          { ...latest, panes, search: visit.context ?? latest.search },
          true,
        );
        if (visit.context) restoreRef.current(visit.context);
      } catch (reason) {
        onError((reason as Error).message);
      }
    },
    [commit, onError],
  );

  const resolvingVersions = useRef(new Set<string>());
  useEffect(() => {
    if (!ready) return;
    for (const target of [0, 1] as const) {
      const visit = ref.current.panes[target].current;
      const doc = documents.find((item) => item.id === visit?.documentId);
      if (
        !visit?.position ||
        !doc ||
        visit.position.version === doc.version ||
        visit.position.content_hash !== doc.content_hash ||
        resolvingVersions.current.has(visit.id)
      )
        continue;
      resolvingVersions.current.add(visit.id);
      void api<{ status: string; position: ReadingPosition }>(
        "/positions/resolve",
        {
          method: "POST",
          body: JSON.stringify(visit.position),
        },
      )
        .then((resolved) => {
          if (
            resolved.status !== "resolved" ||
            ref.current.panes[target].current?.id !== visit.id
          )
            return;
          const previous = ref.current,
            panes = [...previous.panes] as [Pane, Pane];
          panes[target] = {
            ...panes[target],
            current: {
              ...visit,
              id: crypto.randomUUID(),
              position: resolved.position,
              hit: undefined,
            },
          };
          commit({ ...previous, panes }, true);
        })
        .catch((reason) => onError((reason as Error).message))
        .finally(() => resolvingVersions.current.delete(visit.id));
    }
  }, [documents, ready, commit, onError]);

  const selections = useMemo(
    () =>
      state.panes.map((pane) => {
        const visit = pane.current;
        const doc = documents.find((item) => item.id === visit?.documentId);
        if (!doc || !visit) return null;
        return {
          document: doc,
          hit: visit.hit,
          query: visit.context?.query,
          mode: visit.context?.mode,
          expand: visit.context?.expand,
          course: visit.context?.course,
          position: visit.position,
          visitId: visit.id,
        } as Selection;
        // Reading position updates must not trigger a fresh jump in the reader.
      }),
    [documents, state.panes[0].current?.id, state.panes[1].current?.id],
  );

  const activate = useCallback(
    (active: 0 | 1) => {
      if (ref.current.active !== active) commit({ ...ref.current, active });
    },
    [commit],
  );
  const setSearch = useCallback(
    (search: SearchContext) => {
      if (JSON.stringify(search) !== JSON.stringify(ref.current.search))
        commit({ ...ref.current, search });
    },
    [commit],
  );
  const close = (target: 0 | 1) => {
    loadGeneration.current[target]++;
    const previous = ref.current,
      panes = [...previous.panes] as [Pane, Pane];
    panes[target] = {
      ...panes[target],
      saved: panes[target].current ?? panes[target].saved,
      current: null,
    };
    commit(
      {
        ...previous,
        panes,
        dual: target === 1 ? false : previous.dual,
        active: target === 1 ? 0 : previous.active,
      },
      true,
    );
  };
  const toggleDual = async () => {
    if (ref.current.dual) {
      close(1);
      return;
    }
    const previous = ref.current,
      panes = [...previous.panes] as [Pane, Pane];
    const saved = panes[1].saved;
    const token = ++loadGeneration.current[1];
    panes[1] = { ...panes[1], current: null };
    commit({ ...previous, panes, dual: true, active: 1 }, true);
    if (!saved?.position) return;
    try {
      const resolved = await api<{ status: string; position: ReadingPosition }>(
        "/positions/resolve",
        { method: "POST", body: JSON.stringify(saved.position) },
      );
      if (token !== loadGeneration.current[1] || !ref.current.dual) return;
      if (resolved.status !== "resolved") {
        onError("第二栏的资料已变化，位置待确认；可从资料列表重新打开。");
        return;
      }
      const latest = ref.current,
        restoredPanes = [...latest.panes] as [Pane, Pane];
      restoredPanes[1] = {
        ...restoredPanes[1],
        current: {
          ...saved,
          id: crypto.randomUUID(),
          position: resolved.position,
          hit: undefined,
        },
      };
      commit({ ...latest, panes: restoredPanes }, true);
    } catch (reason) {
      if (token === loadGeneration.current[1] && ref.current.dual)
        onError((reason as Error).message);
    }
  };
  return {
    state,
    ready,
    selections,
    open,
    travel,
    updatePosition,
    activate,
    setSearch,
    close,
    toggleDual,
    toggleResults: () =>
      commit({ ...ref.current, collapsed: !ref.current.collapsed }),
    current: () => ref.current.panes[ref.current.active].current,
  };
}
