import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

const STORAGE_KEY = "mystics:sidebar-collapsed";

interface SidebarContextValue {
  collapsed: boolean;
  toggle: () => void;
  setCollapsed: (next: boolean) => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

function readInitial(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsedState] = useState<boolean>(readInitial);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      // ignore storage failures (quota, private mode, etc.)
    }
  }, [collapsed]);

  const toggle = useCallback(() => setCollapsedState((v) => !v), []);
  const setCollapsed = useCallback(
    (next: boolean) => setCollapsedState(next),
    [],
  );

  return (
    <SidebarContext.Provider value={{ collapsed, toggle, setCollapsed }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebarCollapse(): SidebarContextValue {
  const ctx = useContext(SidebarContext);
  if (!ctx) {
    return {
      collapsed: false,
      toggle: () => {},
      setCollapsed: () => {},
    };
  }
  return ctx;
}

export function useOptionalSidebarCollapse(): SidebarContextValue | null {
  return useContext(SidebarContext);
}
