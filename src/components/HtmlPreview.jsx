export default function HtmlPreview({ html }) {
  const srcDoc = html
    ? `${html}\n<script src="https://unpkg.com/pagedjs/dist/paged.polyfill.js"></script>`
    : "<p style='font-family:sans-serif;padding:1rem'>Ingen HTML ännu.</p>";

  return (
    <div className="panel stack">
      <h3>Preview</h3>
      <iframe title="HTML Preview" srcDoc={srcDoc} className="preview-frame" />
    </div>
  );
}
