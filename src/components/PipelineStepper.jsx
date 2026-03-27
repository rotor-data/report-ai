export default function PipelineStepper({ onGenerateSystem, onGenerateModules, onGenerateHtml }) {
  return (
    <div className="panel row-wrap">
      <button className="btn" onClick={onGenerateSystem}>
        1. Generera design system
      </button>
      <button className="btn" onClick={onGenerateModules}>
        2. Generera moduler
      </button>
      <button className="btn" onClick={onGenerateHtml}>
        3. Generera HTML
      </button>
    </div>
  );
}
