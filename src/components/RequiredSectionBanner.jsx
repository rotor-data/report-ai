export default function RequiredSectionBanner({ warnings, onAutoAdd }) {
  if (!warnings?.length) return null;

  return (
    <div className="banner-warning">
      <strong>Saknade obligatoriska sektioner</strong>
      <ul>
        {warnings.map((w, idx) => (
          <li key={`${w.module_type}-${idx}`}>{w.label}</li>
        ))}
      </ul>
      <button className="btn" onClick={onAutoAdd}>
        Lägg till automatiskt
      </button>
    </div>
  );
}
