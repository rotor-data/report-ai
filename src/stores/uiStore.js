import { create } from "zustand";

export const useUiStore = create((set) => ({
  hubToken: "",
  pipelineStep: 0,
  /** HMAC capability token for the scoped /editor/v2 flow */
  editorToken: "",
  /** { reportId, tenantId, brandId } set after editor-session verifies */
  editorScope: null,
  setHubToken: (hubToken) => set({ hubToken }),
  setPipelineStep: (pipelineStep) => set({ pipelineStep }),
  setEditorAuth: (editorToken, editorScope) => set({ editorToken, editorScope }),
  clearEditorAuth: () => set({ editorToken: "", editorScope: null }),
}));
