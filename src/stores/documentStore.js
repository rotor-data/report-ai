import { create } from "zustand";

export const useDocumentStore = create((set) => ({
  document: null,
  validationWarnings: [],
  setDocument: (document) => set({ document }),
  setValidationWarnings: (validationWarnings) => set({ validationWarnings }),
  updateModule: (id, updater) =>
    set((state) => {
      if (!state.document) return state;
      return {
        document: {
          ...state.document,
          module_plan: (state.document.module_plan || []).map((m) => (m.id === id ? { ...m, ...updater(m) } : m)),
        },
      };
    }),
  setModulePlan: (modulePlan) =>
    set((state) => (state.document ? { document: { ...state.document, module_plan: modulePlan } } : state)),
}));
