import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Profile } from "../types";

export default function ProfileSelect({
  value,
  onChange,
  includeEmptyOption,
}: {
  value: string;
  onChange: (profileId: string) => void;
  includeEmptyOption?: string;
}) {
  const [profiles, setProfiles] = useState<Profile[]>([]);

  useEffect(() => {
    api.listProfiles().then(setProfiles).catch(() => setProfiles([]));
  }, []);

  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {includeEmptyOption !== undefined && <option value="">{includeEmptyOption}</option>}
      {profiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.display_name}
        </option>
      ))}
    </select>
  );
}
