import { create } from "zustand";

export const useUiStore = create((set) => ({
  hubToken: "",
  pipelineStep: 0,
  setHubToken: (hubToken) => set({ hubToken }),
  setPipelineStep: (pipelineStep) => set({ pipelineStep }),
}));
