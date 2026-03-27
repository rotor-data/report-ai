import { useUiStore } from "../stores/uiStore";

async function request(path, options = {}) {
  const token = useUiStore.getState().hubToken;
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, {
    ...options,
    headers,
  });

  const isJson = (res.headers.get("content-type") || "").includes("application/json");
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  listDocuments: () => request("/documents"),
  getDocument: (id) => request(`/documents/${id}`),
  createDocument: (payload) => request("/documents", { method: "POST", body: JSON.stringify(payload) }),
  patchDocument: (id, payload) => request(`/documents/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteDocument: (id) => request(`/documents/${id}`, { method: "DELETE" }),
  generateSystem: (payload) => request("/generate-system", { method: "POST", body: JSON.stringify(payload) }),
  generateModules: (payload) => request("/generate-modules", { method: "POST", body: JSON.stringify(payload) }),
  generateHtml: (payload) => request("/generate-html", { method: "POST", body: JSON.stringify(payload) }),
  exportPdf: (payload) => request("/export-pdf", { method: "POST", body: JSON.stringify(payload) }),
  listFonts: () => request("/fonts"),
  uploadFont: (payload) => request("/fonts", { method: "POST", body: JSON.stringify(payload) }),
};
