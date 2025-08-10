import React from "react";

type ToggleProps = {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  note?: string;
};

const Row: React.FC<ToggleProps> = ({ label, value, onChange, note }) => {
  return (
    <div style={{ padding: 12, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
      <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(e.currentTarget.checked)}
        />
      </label>
      {note ? <div style={{ opacity: 0.7, marginTop: 6, fontSize: 12 }}>{note}</div> : null}
    </div>
  );
};

// These settings bind to the runtime Settings object in index.ts.
// In a real Kettu environment, replace with the provided settings storage API.
const Settings = (globalThis as any).__TelegramCallsSettings ??= {
  forceModeNormalOnWired: true,
  keepStereoMedia: true,
  disableAttenuation: true,
  relaxMicDSP: true,
  verboseLogs: false,
};

const SettingsComponent: React.FC = () => {
  const [s, setS] = React.useState({ ...Settings });

  function upd<K extends keyof typeof Settings>(k: K, v: boolean) {
    Settings[k] = v;
    setS({ ...Settings });
  }

  return (
    <div style={{ padding: 8 }}>
      <Row
        label="Force MODE_NORMAL on wired"
        value={s.forceModeNormalOnWired}
        onChange={(v) => upd("forceModeNormalOnWired", v)}
        note="Avoids in-call audio mode when headphones are wired; helps keep stereo fidelity."
      />
      <Row
        label="Keep stereo media"
        value={s.keepStereoMedia}
        onChange={(v) => upd("keepStereoMedia", v)}
        note="Prefers 2-channel, 48 kHz output for media while you’re in a call."
      />
      <Row
        label="Disable attenuation"
        value={s.disableAttenuation}
        onChange={(v) => upd("disableAttenuation", v)}
        note="Stops Discord from lowering media volume when people speak."
      />
      <Row
        label="Relax mic DSP"
        value={s.relaxMicDSP}
        onChange={(v) => upd("relaxMicDSP", v)}
        note="Turns off AGC/NS/EC to avoid overprocessing your mic."
      />
      <Row
        label="Verbose logs"
        value={s.verboseLogs}
        onChange={(v) => upd("verboseLogs", v)}
        note="Log plugin actions to the console for debugging."
      />
    </div>
  );
};

SettingsComponent.displayName = "TelegramCallsSettings";

export default SettingsComponent;
