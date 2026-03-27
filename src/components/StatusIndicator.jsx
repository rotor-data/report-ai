/**
 * Shows the current generation status of a document.
 * Replaces PipelineStepper — generation now happens via Claude/MCP, not direct API calls.
 */
export default function StatusIndicator({ document }) {
  if (!document) return null;

  const steps = [
    { label: "Design System", done: !!document.design_system, field: "design_system" },
    { label: "Modulplan", done: !!document.module_plan?.length, field: "module_plan" },
    { label: "HTML", done: !!document.html_output, field: "html_output" },
  ];

  const isGenerating = document.status === "generating";

  return (
    <div className="panel row-wrap" style={{ gap: "1.5rem", alignItems: "center" }}>
      {steps.map((step) => (
        <div key={step.field} style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          <span style={{ fontSize: "1.2em" }}>
            {step.done ? "✅" : isGenerating ? "⏳" : "⬜"}
          </span>
          <span style={{ opacity: step.done ? 1 : 0.5 }}>{step.label}</span>
        </div>
      ))}
      {isGenerating && (
        <span style={{ fontSize: "0.85em", color: "#666" }}>
          Generering pågår via Claude i Hubben...
        </span>
      )}
    </div>
  );
}
