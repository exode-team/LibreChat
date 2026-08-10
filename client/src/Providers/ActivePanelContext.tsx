import { createContext, useCallback, useContext, useMemo, useState, ReactNode } from 'react';

const STORAGE_KEY = 'side:active-panel';
export const DEFAULT_PANEL = 'conversations';

function getInitialActivePanel(isEmbed: boolean): string {
  if (isEmbed) {
    return DEFAULT_PANEL;
  }
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved ? saved : DEFAULT_PANEL;
}

interface ActivePanelContextType {
  active: string;
  setActive: (id: string) => void;
}

const ActivePanelContext = createContext<ActivePanelContextType | undefined>(undefined);

/**
 * `isEmbed` opts the exode embed out of the shared `side:active-panel` localStorage key.
 * The embed and the main LibreChat app run on the same origin, so without this the embed's
 * default panel is whatever was last open in the main app (e.g. Memories) — even though the
 * embed hides the icon rail that would let a user navigate there themselves.
 */
export function ActivePanelProvider({
  children,
  isEmbed = false,
}: {
  children: ReactNode;
  isEmbed?: boolean;
}) {
  const [active, _setActive] = useState<string>(() => getInitialActivePanel(isEmbed));

  const setActive = useCallback(
    (id: string) => {
      if (!isEmbed) {
        localStorage.setItem(STORAGE_KEY, id);
      }
      _setActive(id);
    },
    [isEmbed],
  );

  const value = useMemo(() => ({ active, setActive }), [active, setActive]);

  return <ActivePanelContext.Provider value={value}>{children}</ActivePanelContext.Provider>;
}

export function useActivePanel() {
  const context = useContext(ActivePanelContext);
  if (context === undefined) {
    throw new Error('useActivePanel must be used within an ActivePanelProvider');
  }
  return context;
}

/** Returns `active` when it matches a known link, otherwise the first link's id. */
export function resolveActivePanel(active: string, links: { id: string }[]): string {
  if (links.length > 0 && links.some((l) => l.id === active)) {
    return active;
  }
  return links[0]?.id ?? active;
}
