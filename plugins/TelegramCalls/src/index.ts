// TelegramCalls — Kettu/Bunny-style plugin
// Notes:
// - Uses generic Metro finders and a tiny monkey patch helper.
// - Targets Discord mobile’s voice/media stores and RN NativeModules for audio mode.
// - Falls back gracefully when a module isn’t found.

type Unpatch = () => void;

const patches: Unpatch[] = [];

function monkeyPatch<T extends object, K extends keyof T>(
  obj: T,
  method: K,
  patcher: (original: T[K]) => T[K]
): Unpatch {
  const orig = obj[method];
  // @ts-ignore
  obj[method] = patcher(orig);
  return () => {
    // @ts-ignore
    obj[method] = orig;
  };
}

// Very generic Metro finders used by Bunny/Kettu-like environments.
// If your environment exposes better finders (e.g., findByProps), swap these.
function getModules(): Record<string, any>[] {
  const g: any = globalThis as any;
  // Common RN/Metro entry points
  const possible = [g.modules, g.__r?.getModules?.(), g.__r?.modules, g.__c?.modules];
  for (const candidate of possible) {
    if (!candidate) continue;
    if (Array.isArray(candidate)) return candidate as any;
    if (typeof candidate === "object") return Object.values(candidate) as any;
  }
  return [];
}

function findByProps(...props: string[]): any | null {
  for (const mod of getModules()) {
    try {
      const exp = mod?.exports ?? mod;
      if (!exp || typeof exp !== "object") continue;
      if (props.every((p) => p in exp)) return exp;
      // Some modules export default
      const d = (exp as any).default;
      if (d && typeof d === "object" && props.every((p) => p in d)) return d;
    } catch {}
  }
  return null;
}

function findByDisplayName(name: string): any | null {
  for (const mod of getModules()) {
    const exp = mod?.exports ?? mod;
    const cand = exp?.default ?? exp;
    if (cand?.displayName === name || cand?.name === name) return cand;
  }
  return null;
}

// Settings (runtime) with sane defaults. Replace with Kettu’s settings API if available.
const Settings = {
  forceModeNormalOnWired: true,
  keepStereoMedia: true,
  disableAttenuation: true,
  relaxMicDSP: true,
  verboseLogs: false,
};

function log(...args: any[]) {
  if (Settings.verboseLogs) console.log("[TelegramCalls]", ...args);
}

// Resolve likely targets
const VoiceStore = findByProps("getCurrentVoiceChannelId", "isInCall");
const MediaEngine = findByProps("setSelfMute", "setInputVolume", "setNoiseSuppression");
const AttenuationStore = findByProps("getAttenuation", "setAttenuation");
const AudioManagerNative =
  // Typical RN bridges people name; try a few
  (globalThis as any).NativeModules?.RNCAudioManager ||
  (globalThis as any).NativeModules?.AudioManager ||
  findByProps("setMode", "setSpeakerphoneOn");

const DeviceManager = findByProps("isHeadsetConnected", "isBluetoothConnected");

// Voice connection controller (join/leave hooks)
const VoiceConnection = findByProps("join", "leave", "setLocalMute") ||
  findByProps("joinCall", "leaveCall");

function isWiredHeadphones(): boolean {
  try {
    if (DeviceManager?.isHeadsetConnected) return !!DeviceManager.isHeadsetConnected();
  } catch {}
  return false;
}

function safeSetAudioModeNormal() {
  try {
    if (!AudioManagerNative?.setMode) return;
    // 0 == MODE_NORMAL on Android
    AudioManagerNative.setMode(0);
    log("Forced AudioManager.MODE_NORMAL");
  } catch (e) {
    log("setMode failed", e);
  }
}

function ensureMediaStreamNotDucked() {
  try {
    if (!AttenuationStore?.setAttenuation) return;
    // 0% attenuation matches user setting “don’t lower other apps”
    AttenuationStore.setAttenuation(0);
    log("Attenuation set to 0%");
  } catch (e) {
    log("Failed to set attenuation", e);
  }
}

function relaxMicProcessing() {
  if (!MediaEngine) return;
  try {
    // Many of these no-ops if the platform module doesn’t support them.
    MediaEngine.setEchoCancellation?.(false);
    MediaEngine.setNoiseSuppression?.(false);
    MediaEngine.setAutomaticGainControl?.(false);
    MediaEngine.setOpusEncoderEnableFEC?.(true); // keep FEC for resilience
    MediaEngine.setOpusBitrate?.(64000); // reasonable speech bitrate without over-compressing
    log("Relaxed mic DSP and set bitrate");
  } catch (e) {
    log("Mic DSP tuning failed", e);
  }
}

function preferStereoOutput() {
  try {
    // Some builds expose an output config or player options
    const Player = findByProps("setChannelCount", "setSampleRate") || findByProps("setOutputConfig");
    if (Player?.setChannelCount) Player.setChannelCount(2);
    if (Player?.setSampleRate) Player.setSampleRate(48000);
    log("Preferred stereo, 48 kHz output");
  } catch (e) {
    log("Stereo preference failed", e);
  }
}

function onCallStart() {
  if (Settings.disableAttenuation) ensureMediaStreamNotDucked();
  if (Settings.keepStereoMedia) preferStereoOutput();
  if (Settings.relaxMicDSP) relaxMicProcessing();
  if (Settings.forceModeNormalOnWired && isWiredHeadphones()) safeSetAudioModeNormal();
}

function onCallEnd() {
  // Attempt to restore app-managed defaults where possible.
  try {
    if (Settings.relaxMicDSP && MediaEngine) {
      MediaEngine.setEchoCancellation?.(true);
      MediaEngine.setNoiseSuppression?.(true);
      MediaEngine.setAutomaticGainControl?.(true);
      log("Restored mic DSP defaults");
    }
  } catch {}
}

// Patch join/leave call paths
function patchVoiceJoinLeave() {
  if (!VoiceConnection) return;

  // Prefer explicit join/leave if present
  if ("joinCall" in VoiceConnection && "leaveCall" in VoiceConnection) {
    patches.push(
      monkeyPatch(VoiceConnection, "joinCall" as any, (orig: any) => {
        return async function (...args: any[]) {
          const res = await orig.apply(this, args);
          onCallStart();
          return res;
        };
      })
    );
    patches.push(
      monkeyPatch(VoiceConnection, "leaveCall" as any, (orig: any) => {
        return async function (...args: any[]) {
          try {
            const res = await orig.apply(this, args);
            onCallEnd();
            return res;
          } finally {
            onCallEnd();
          }
        };
      })
    );
    return;
  }

  // Fallback: patch generic join/leave
  if ("join" in VoiceConnection && "leave" in VoiceConnection) {
    patches.push(
      monkeyPatch(VoiceConnection, "join" as any, (orig: any) => {
        return async function (...args: any[]) {
          const res = await orig.apply(this, args);
          onCallStart();
          return res;
        };
      })
    );
    patches.push(
      monkeyPatch(VoiceConnection, "leave" as any, (orig: any) => {
        return async function (...args: any[]) {
          try {
            const res = await orig.apply(this, args);
            onCallEnd();
            return res;
          } finally {
            onCallEnd();
          }
        };
      })
    );
  }
}

// Optional: continuously enforce attenuation/stereo in case Discord resets them mid-call
let intervalId: any;
function startWatchdog() {
  stopWatchdog();
  intervalId = setInterval(() => {
    if (!VoiceStore?.isInCall?.()) return;
    if (Settings.disableAttenuation) ensureMediaStreamNotDucked();
    if (Settings.keepStereoMedia) preferStereoOutput();
  }, 2000);
}
function stopWatchdog() {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
}

// Public plugin API expected by Bunny/Kettu-like loaders
export const onLoad = () => {
  log("Loading TelegramCalls");
  patchVoiceJoinLeave();
  startWatchdog();
  // If already in a call, apply immediately
  try {
    if (VoiceStore?.isInCall?.()) onCallStart();
  } catch {}
};

export const onUnload = () => {
  log("Unloading TelegramCalls");
  for (const un of patches.splice(0)) try { un(); } catch {}
  stopWatchdog();
  onCallEnd();
};

// Settings UI registration is typically done via a settings export.
// Kettu can import settings component from settings.tsx.
export { default as settings } from "./settings";
