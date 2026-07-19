import { useState } from "react";

export default function KeyValueEditor({
  values,
  onChange,
}: {
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}) {
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  function updateEntry(key: string, value: string) {
    onChange({ ...values, [key]: value });
  }

  function removeEntry(key: string) {
    const next = { ...values };
    delete next[key];
    onChange(next);
  }

  function addEntry() {
    const key = newKey.trim();
    if (!key) return;
    onChange({ ...values, [key]: newValue.trim() });
    setNewKey("");
    setNewValue("");
  }

  return (
    <div className="kv-editor">
      {Object.entries(values).map(([key, value]) => (
        <div className="kv-row" key={key}>
          <span className="kv-key">{key}</span>
          <input value={value} onChange={(e) => updateEntry(key, e.target.value)} />
          <button type="button" className="kv-remove" onClick={() => removeEntry(key)}>
            ×
          </button>
        </div>
      ))}
      <div className="kv-row kv-add">
        <input placeholder="key" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
        <input placeholder="value" value={newValue} onChange={(e) => setNewValue(e.target.value)} />
        <button type="button" onClick={addEntry}>
          Add
        </button>
      </div>
    </div>
  );
}
