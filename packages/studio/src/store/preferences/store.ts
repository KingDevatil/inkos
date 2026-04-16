import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ViewMode = "classic" | "chat-first";

interface PreferencesState {
  // View mode: "classic" = current project (BookDetail centered), "chat-first" = original project (Chat centered)
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  toggleViewMode: () => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set, get) => ({
      viewMode: "classic",
      setViewMode: (mode) => set({ viewMode: mode }),
      toggleViewMode: () => {
        const current = get().viewMode;
        set({ viewMode: current === "classic" ? "chat-first" : "classic" });
      },
    }),
    {
      name: "inkos-preferences",
    }
  )
);
