import { useCallback, useEffect, useRef, useState } from "react";

/** Loads on mount, then every `ms`. Keeps the last good data while a refresh is in flight or fails. */
export function usePoll<T>(load: () => Promise<T>, ms = 3000, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), ms);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, refresh, ...deps]);

  return { data, error, refresh };
}

export function useHashRoute(): [string, (to: string) => void] {
  const read = () => window.location.hash.replace(/^#/, "") || "/activity";
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [route, (to) => (window.location.hash = to)];
}

/** True while the viewport is at most `maxPx` wide. Follows resizes and rotation; false where matchMedia does not exist. */
export function useNarrow(maxPx = 700): boolean {
  const query = `(max-width: ${maxPx}px)`;
  const get = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false);
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return narrow;
}
