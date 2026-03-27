import { api } from "../api/client";

export default function ExportButton({ documentId }) {
  const exportPdf = async () => {
    const res = await api.exportPdf({ document_id: documentId });
    const href = `data:application/pdf;base64,${res.pdf_base64}`;
    const a = document.createElement("a");
    a.href = href;
    a.download = `report-${documentId}.pdf`;
    a.click();
  };

  return (
    <button className="btn" onClick={exportPdf}>
      Exportera PDF
    </button>
  );
}
