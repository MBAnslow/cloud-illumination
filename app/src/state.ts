import { create } from "zustand";
import { CUSTOM_SWATCH_ID, getSwatch } from "./lighting/swatches";
import {
  DEFAULT_LED_COLOR_PROFILE,
  resolveLedColorProfile,
  type LedColorProfile,
} from "./lighting/ledColor";
import { loadSnapshot, type Snapshot } from "./state/persistence";
import {
  buildDual32x8Slotted,
  DEFAULT_ARCH_PLACEMENTS,
  DEFAULT_LAYOUT_PITCH,
  DUAL_32X8_SLOTTED,
  resolveArchPlacements,
  type ArchPlacement,
  type LedLayoutId,
} from "./mapping/ledLayout";

export type Vec3 = [number, number, number];

/**
 * How the per-LED points are visualized in the 3D scene:
 *   "sensors" — matte spheres that sample lighting at their surface
 *               position. Represents the sampling side of the rendering
 *               pipeline (what the app uses internally to decide colors).
 *   "leds"    — narrow oriented hemispheres with additive blending that
 *               emit their per-LED stream color. Represents what actually
 *               gets streamed to WLED.
 */
export type LedDisplayMode = "sensors" | "leds";
export interface LedStreamPipeline {
  /** Enables the base time-of-day lighting stage. */
  timeOfDayStage: boolean;
  /** Enables additive lightning contribution stage. */
  lightningStage: boolean;
  /** Enables locator hard override in streamed output. */
  locatorOverrideStage: boolean;
}

/**
 * Animatable lightning params — stored per keyframe and linearly
 * interpolated across the lightning active window (sky timeline).
 * Only these fields ride the storm envelope; geometry/look extras stay global.
 */
/** main, highlight1, highlight2 — sampled live from colour-stop timelines. */
export type LightningPalette = [string, string, string];

/**
 * A colour pin on a lightning colour/tint timeline. `t` is progress
 * through the lightning active window, [0, 1] (same axis as storm keys).
 */
export interface LightningColorStop {
  id: string;
  t: number;
  color: string;
}

/** Default bolt colour: main + two highlight channel timelines. */
export interface LightningColorTracks {
  main: LightningColorStop[];
  highlight1: LightningColorStop[];
  highlight2: LightningColorStop[];
}

function makeColorStopId(): string {
  return `lcs-${Math.random().toString(36).slice(2, 8)}`;
}

function channelStopsPair(
  colorA: string,
  colorB: string,
): LightningColorStop[] {
  return [
    { id: makeColorStopId(), t: 0, color: colorA },
    { id: makeColorStopId(), t: 1, color: colorB },
  ];
}

export function buildDefaultLightningColors(): LightningColorTracks {
  return {
    main: channelStopsPair("#cfe7ff", "#e8f4ff"),
    highlight1: channelStopsPair("#a8c8ff", "#c4d9ff"),
    highlight2: channelStopsPair("#fff2c9", "#fff6d6"),
  };
}

export interface LightningAnimParams {
  intensityRange: [number, number];
  /** Cloud-flash strikes per real (wall-clock) minute at this storm point. */
  strikesPerMinute: number;
  /**
   * Cloud-to-ground "strike" bolts per real minute. These start at the
   * cloud top, hit the ground, and flood-light the whole cloud.
   */
  strikePerMinute: number;
  /**
   * Transient image “sprites” projected through the cloud per real minute.
   * Each trigger picks a random uploaded image and a random ±X/Y/Z axis.
   */
  spritesPerMinute: number;
  /** Per-sprite strobe duty range sampled at spawn, [0.05, 0.95]. */
  spriteStrobeDutyRange: [number, number];
  /**
   * Per-segment branch probability in [0, 1]. At each interior main-bolt
   * vertex, a weaker side branch spawns with this chance (1 = every segment).
   */
  subFlashes: number;
  /** Max bolt endpoint span as a fraction of cloud size, [0, 1]. */
  spanScale: number;
  /** Min bolt length as a fraction of mean cloud radius. */
  minSpanScale: number;
  boltGain: number;
  /** Additive gain for projected sprite image flashes. */
  spriteGain: number;
  backgroundGain: number;
  thunderDelayMs: number;
  /** Stereo pan for bolt/background audio, −1 = left … +1 = right. */
  pan: number;
}

export interface LightningKeyframe {
  id: string;
  /**
   * Normalized progress through the lightning active window, [0, 1].
   * Sampled from the current sky timeline position.
   */
  t: number;
  values: LightningAnimParams;
}

export interface LightningParams {
  enabled: boolean;
  /**
   * Default bolt colour timelines (main + 2 highlights). Interpolate
   * across the storm window like sky sun/moon pins.
   */
  colors: LightningColorTracks;
  /**
   * Per-strike additive gain range. Mirrored in keyframes; live flashes
   * interpolate the range and map a frozen per-strike random through it.
   */
  intensityRange: [number, number];
  /**
   * Keyframes over the lightning active window (sky timeline progress).
   * Current sky time maps to u∈[0,1] within Start→End hour; values are
   * linearly interpolated. ≥2 stops.
   */
  keyframes: LightningKeyframe[];
  /** Average cloud-flash strikes per real (wall-clock) minute. Also keyframed. */
  strikesPerMinute: number;
  /**
   * Average cloud-to-ground strikes per real minute. Also keyframed.
   * Separate from in-cloud flashes.
   */
  strikePerMinute: number;
  /**
   * Average projected sprite flashes per real minute. Also keyframed.
   * Requires at least one uploaded `spriteSamples` image.
   */
  spritesPerMinute: number;
  /**
   * Characteristic distance (m) over which an LED's contribution from a
   * lit segment drops by 1/e. Continuous exponential falloff — every
   * LED receives some light, larger values = more diffuse glow through
   * the cloud. Global (not keyframed).
   */
  falloffDistance: number;
  /** Number of samples in a bolt polyline (jaggedness). */
  boltSegments: number;
  /** Per-strike lateral randomness range, [0,1]. Sampled per strike. */
  boltJitterRange: [number, number];
  /**
   * Per-strike bolt tip travel speed range, in world metres per second.
   * The flash duration is derived from `path_length / speed * 4` so
   * longer bolts and slower speeds automatically produce longer flashes.
   * The `* 4` factor preserves the historical ~25% travel / ~75% fade
   * envelope split.
   */
  travelSpeedRange: [number, number];
  /**
   * Per-segment branch probability in [0, 1]. Mirrored in keyframes;
   * live strikes sample the interpolated value at spawn.
   */
  subFlashes: number;
  /** Max portion of the ellipsoid extents the bolt endpoints span, [0,1]. */
  spanScale: number;
  /**
   * Minimum bolt length as a fraction of the mean ellipsoid radius.
   * If randomly sampled endpoints fall closer than this, we resample
   * so bolts don't degenerate into a tiny spark.
   */
  minSpanScale: number;
  /** Hour in [0, 24) at which lightning activity switches on. */
  activeStartHour: number;
  /** Hour in [0, 24) at which lightning activity switches off. */
  activeEndHour: number;
  /**
   * Uploaded cloud-flash sound library. One is chosen (by intensity /
   * length tags) per in-cloud bolt (`strikesPerMinute` / kind "cloud").
   */
  boltSamples: LightningSample[];
  /**
   * Single one-shot for cloud-to-ground strikes (`strikePerMinute` /
   * kind "strike"). Null = silent for ground strikes.
   */
  strikeSample: LightningSample | null;
  /** Optional looping background ambience (rain, thunder rumble, …). */
  backgroundSample: LightningSample | null;
  /** Randomly selected one-shot audio library for storm sprite flashes. */
  spriteAudioSamples: LightningSample[];
  /**
   * Uploaded sprite image library. Each sprite trigger picks one at
   * random and projects it through the cloud along a random ±X/Y/Z axis.
   */
  spriteSamples: LightningSpriteSample[];
  /**
   * How long a sprite flash lasts (ms), including on/off strobe pulses.
   * Global (not keyframed).
   */
  spriteDurationMs: number;
  /** Strobe flash rate in Hz while a sprite is active. */
  spriteStrobeHz: number;
  /** Fraction of each strobe period the image is “on”, [0.05, 0.95]. */
  spriteStrobeDuty: number;
  /**
   * Base playback gain for bolt sounds. The actual per-trigger gain
   * is scaled by the strike's sampled intensity so louder flashes get
   * louder bolts and gentler flashes fade toward this floor.
   */
  boltGain: number;
  /** Additive LED gain for projected sprites. Also keyframed. */
  spriteGain: number;
  /** Playback gain for the sprite sound effect, independent of brightness. */
  spriteAudioGain: number;
  /** Modulate sprite brightness from the source audio waveform. */
  spriteAudioReactiveBrightness: boolean;
  /** Playback gain for the background loop, [0, 1]. */
  backgroundGain: number;
  /**
   * ± range in cents for a random pitch shift applied to each bolt
   * trigger (uniform in [-range, +range]). 0 = deterministic.
   */
  boltPitchJitterCents: number;
  /**
   * Delay in milliseconds between the visual bolt spawning and the
   * bolt sample being triggered. Mimics thunder arriving after the
   * flash (sound travels ~340 m/s vs. instantaneous light). 0 = fire
   * simultaneously. Clamped to [0, 2000] on load.
   */
  thunderDelayMs: number;
  /**
   * Stereo pan for bolt and background audio (−1 left … +1 right).
   * Also keyframed across the active window.
   */
  pan: number;
  /**
   * Target simulation FPS for lightning updates + LED contribution.
   * Lower values create a stroboscopic, film-like flicker by
   * refreshing bolt state less often than the render loop.
   * Range 1..60.
   */
  simFps: number;
}

/**
 * Metadata for a lightning audio asset. The binary blob lives in
 * IndexedDB (shared with the samples panel storage) keyed by `id`;
 * only these lightweight fields make it into the localStorage
 * snapshot. `durationSec` is optional (background loop doesn't need
 * it) and populated at upload time when known.
 */
export type BoltIntensityTag = "low" | "medium" | "high";
export type BoltLengthTag = "short" | "medium" | "long";

export const BOLT_INTENSITY_TAGS: BoltIntensityTag[] = [
  "low",
  "medium",
  "high",
];
export const BOLT_LENGTH_TAGS: BoltLengthTag[] = ["short", "medium", "long"];

/** Metadata for a storm sprite image (blob in IndexedDB by `id`). */
export interface LightningSpriteSample {
  id: string;
  name: string;
  width?: number;
  height?: number;
}

export interface LightningSample {
  id: string;
  name: string;
  durationSec?: number;
  /** Per-asset playback trim. Defaults to 1 for legacy samples. */
  gain?: number;
  /**
   * Manual intensity bands this clip suits. Empty = untagged (matches
   * any intensity as a fallback). Tick one or more in the lightning UI.
   */
  intensityTags: BoltIntensityTag[];
  /**
   * Manual flash-length bands this clip suits. Empty = untagged
   * (matches any length as a fallback).
   */
  lengthTags: BoltLengthTag[];
}

/** Ellipsoid semi-axes in metres. */
export interface EllipsoidParams {
  rx: number;
  ry: number;
  rz: number;
}

export interface CloudParams {
  /**
   * Cloud opacity, in [0, 1]:
   *   0 — fully transparent; the cloud blocks no light, every LED gets the
   *       same hemispherical irradiance regardless of which side it's on.
   *   1 — fully opaque; LEDs on the far side of the cloud relative to a
   *       light source receive nothing (the original half-Lambert response).
   * Values in between fade smoothly between the two extremes.
   */
  opacity: number;
  /**
   * Whether the ellipsoid mesh is rendered in the 3D view. The LED shading
   * always uses `opacity` regardless of this flag — toggling it just hides
   * or shows the visual representation of the cloud body.
   */
  showOpacity: boolean;
  /** Rotation of the cloud around world up axis, in degrees. */
  rotationYDeg: number;
  /** Tilt of the cloud around world X axis, in degrees. */
  rotationXDeg: number;
  /** World-space X offset of the cloud center, in metres. */
  offsetX: number;
  /** World-space Y offset of the cloud center, in metres. Positive
   * values lift the whole cloud (mesh + LEDs) up off the ground. */
  offsetY: number;
  /** World-space Z offset of the cloud center, in metres. */
  offsetZ: number;
  /**
   * When true, per-LED mapping offsets (along surface normals) are applied
   * in the simulator. When false, LEDs sit on their hand-placed surface
   * positions only.
   */
  applyLedOffset: boolean;
}

/** A second, visual-only GLB that diffuses the live LED output. */
export interface CloudTopParams {
  /** IndexedDB blob id, or null when no cloud-top model is loaded. */
  id: string | null;
  /** Display name of the uploaded model. */
  name: string;
  visible: boolean;
  /** Transform relative to the global cloud transform. */
  scale: number;
  yawDeg: number;
  tiltDeg: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
  /** Surface appearance. */
  tint: string;
  /** Strength and local-space spread of LED light transported by the model. */
  glowStrength: number;
  glowRadius: number;
  /** Cosine-lobe exponent for outward emission; higher values narrow the beam. */
  glowFocus: number;
}

export interface StrandParams {
  /** Bead size for each rendered LED, in metres. */
  ledSize: number;
  /**
   * Hemisphere averaging focus for sensor sampling.
   * 0 = uniform hemisphere average; higher values bias samples toward the
   * sensor normal (head-on light contributes more than grazing light).
   */
  sensorHemisphereFocus: number;
  /** Hue-preserving brightness gamma applied to final LED output. */
  colorProfile: LedColorProfile;
}

export interface AmbientLightParams {
  color: string;
  intensity: number;
  /** Suppress ambient/sky fill where direct light is strong. */
  ducking: number;
}

export interface DirectionalLightParams {
  color: string;
  intensity: number;
  /** World-space position of the directional light source (metres). */
  position: Vec3;
  /**
   * Angular spread of the light in [0, 1]:
   *   0 — perfectly narrow / point-source / "laser": only the half of the
   *       cloud facing the light is illuminated, with a hard terminator at
   *       the equator (flat Lambert `max(0, n · ℓ)` regardless of cloud
   *       opacity).
   *   1 — fully broad / hemispherical "sky": light wraps around the LED's
   *       outward hemisphere, side LEDs get partial illumination, and
   *       cloud opacity controls how much of that wrap reaches the back.
   * Values in between blend linearly. With `spread = 1` the shading model
   * is identical to the previous behavior, so this parameter cleanly
   * extends the old one without changing existing presets.
   */
  spread: number;
}

/** Which sky channel a stop belongs to. */
export type SkyChannel = "sun" | "moon" | "ambient";

/**
 * A single stop on one sky channel's timeline. Pins a single color
 * (only for its channel) at a specific hour. Each channel has its own
 * independent list of stops, so you can shape sun, moon, and ambient
 * colors on completely different schedules.
 *
 * `swatchId` references either a named preset in `SKY_SWATCHES` or the
 * sentinel value `"custom"`. It's UI-only metadata used to display the
 * swatch name and to detect when a user has hand-edited a stop away
 * from its preset. The actual color on the stop is the source of
 * truth for the shading model.
 */
export interface SkyChannelStop {
  id: string;
  /** Time of day in decimal hours, in [0, 24). */
  timeHours: number;
  /** Preset id from `SKY_SWATCHES`, or "custom". */
  swatchId: string;
  color: string;
}

export interface SkyParams {
  /** Enables the sun/moon 24-hour sky sequence. */
  enabled: boolean;
  /** Master amount of the time-of-day visualization effect. */
  visualizationAmount: number;
  /** Advances `timeHours` automatically every frame. */
  autoPlay: boolean;
  /** Time of day in decimal hours [0, 24). */
  timeHours: number;
  /** How many real-time seconds one full 24h sky cycle takes. */
  cycleSeconds: number;
  /** Global intensity scale for the sky ambient component. */
  ambientScale: number;
  /** Global intensity scale for sun contribution. */
  sunScale: number;
  /** Global intensity scale for moon contribution. */
  moonScale: number;
  /** Angular spread of sun light (0 = tight hotspot, 1 = broad sky-like). */
  sunSpread: number;
  /** Angular spread of moon light (0 = tight hotspot, 1 = broad sky-like). */
  moonSpread: number;
  /** Radial sun beam falloff (0 = flat cone, 1 = centre-weighted). */
  sunBeamFocus: number;
  /** Exaggerate illumination on the cloud crown while the sun is low. */
  sunTopHighlightBoost: number;
  /** Radial moon beam falloff (0 = flat cone, 1 = centre-weighted). */
  moonBeamFocus: number;
  /** Point-light distance falloff exponent shared by sun and moon. */
  lightDecay: number;
  /** Show visual cone overlays for sun/moon spread. */
  showSpreadCones: boolean;
  /** Legacy spherical orbit radius (metres), retained for compatibility. */
  orbitRadius: number;
  /** Ellipsoidal orbit radii for simulated sun/moon point lights (metres). */
  orbitRadiusX: number;
  orbitRadiusY: number;
  orbitRadiusZ: number;
  /** Legacy shared horizon controls retained for snapshot compatibility. */
  horizonCutoffDeg?: number;
  horizonSoftnessDeg?: number;
  /** Sun altitude where its contribution begins and reaches full strength. */
  sunHorizonStartDeg: number;
  sunHorizonFullDeg: number;
  /** Moon altitude where its contribution begins and reaches full strength. */
  moonHorizonStartDeg: number;
  moonHorizonFullDeg: number;
  /**
   * Draggable timeline of sun-color stops across the 24-hour day. The
   * sky cycle sorts stops by `timeHours` internally and interpolates
   * linearly between neighbours (wrapping midnight → next stop + 24h).
   */
  sunStops: SkyChannelStop[];
  /** Draggable moon-color timeline (independent from sun and ambient). */
  moonStops: SkyChannelStop[];
  /** Draggable ambient-color timeline (independent from sun and moon). */
  ambientStops: SkyChannelStop[];
}

/** Legacy single-list stop, kept only for one-shot snapshot migration. */
interface LegacyTriStop {
  id: string;
  timeHours: number;
  swatchId: string;
  ambientColor: string;
  sunColor: string;
  moonColor: string;
}

/**
 * A named contiguous slice of the 24h day. `endHour < startHour`
 * means the period wraps midnight (e.g. Night = 20 → 0).
 * Two adjacent periods share an edge — the "next" period always
 * begins where the previous one ends.
 */
export interface DayPeriod {
  id: string;
  name: string;
  startHour: number;
  endHour: number;
  /** Display swatch on the day-cycle bar and scrubber overlay. */
  color: string;
}

export interface DayCycleParams {
  periods: DayPeriod[];
  activePeriodId: string;
  /**
   * When true and `sky.autoPlay` is on, the clock advances into the
   * next period at the end of the current one instead of looping
   * inside it. Off = classic behaviour (loop within period until the
   * user clicks Next).
   */
  autoNext: boolean;
}

/** Length of a period in decimal hours, handling wrap-around. */
export function periodLengthHours(p: DayPeriod): number {
  return p.endHour >= p.startHour
    ? p.endHour - p.startHour
    : 24 - p.startHour + p.endHour;
}

/**
 * Whether the given hour is inside `[startHour, endHour)` on a cyclic
 * 24h axis (handling `end < start` wrap).
 */
export function periodContainsHour(p: DayPeriod, hour: number): boolean {
  const n = ((hour % 24) + 24) % 24;
  return p.endHour >= p.startHour
    ? n >= p.startHour && n < p.endHour
    : n >= p.startHour || n < p.endHour;
}

/**
 * True when `hour` sits inside `[startHour, endHour)` on the cyclic
 * 24h axis. When `endHour < startHour` the range wraps midnight
 * (e.g. 20 → 4 covers 20..24 and 0..4).
 */
export function hourInRange(
  hour: number,
  startHour: number,
  endHour: number,
): boolean {
  const n = ((hour % 24) + 24) % 24;
  const start = Math.max(0, Math.min(24, startHour));
  const end = Math.max(0, Math.min(24, endHour));
  if (end === start) return false;
  return end > start
    ? n >= start && n < end
    : n >= start || n < end;
}

/**
 * Progress through an active hour window as `u ∈ [0, 1]`.
 * Maps the current sky hour onto a keyframe timeline.
 * Returns 0 when outside the window.
 */
export function activeWindowProgress(
  hour: number,
  startHour: number,
  endHour: number,
): number {
  if (!hourInRange(hour, startHour, endHour)) return 0;
  const n = ((hour % 24) + 24) % 24;
  const start = ((startHour % 24) + 24) % 24;
  // Allow endHour === 24 to mean end-of-day (exclusive midnight).
  const end =
    endHour >= 24 ? 24 : ((endHour % 24) + 24) % 24;
  let elapsed: number;
  let duration: number;
  if (end > start) {
    elapsed = n - start;
    duration = end - start;
  } else if (end === 24 && start === 0) {
    elapsed = n;
    duration = 24;
  } else {
    duration = 24 - start + end;
    elapsed = n >= start ? n - start : 24 - start + n;
  }
  if (duration <= 1e-9) return 0;
  return Math.max(0, Math.min(1, elapsed / duration));
}

/** Length of `[startHour, endHour)` on the cyclic 24h axis. */
export function activeWindowDurationHours(
  startHour: number,
  endHour: number,
): number {
  const start = ((startHour % 24) + 24) % 24;
  const end = ((endHour % 24) + 24) % 24;
  if (end === start) return 0;
  return end > start ? end - start : 24 - start + end;
}

function linearHourSpans(
  startHour: number,
  endHour: number,
): Array<[number, number]> {
  const start = ((startHour % 24) + 24) % 24;
  const end = ((endHour % 24) + 24) % 24;
  if (end === start) return [];
  if (end > start) return [[start, end]];
  return [
    [start, 24],
    [0, end],
  ];
}

/**
 * Hours elapsed from `startHour` to `hour` along the active window
 * (supports `hour === 24` as end-of-day for exclusive span ends).
 */
function offsetHoursFromWindowStart(hour: number, startHour: number): number {
  const start = ((startHour % 24) + 24) % 24;
  const h = hour >= 24 ? 24 : ((hour % 24) + 24) % 24;
  if (h >= start) return h - start;
  return 24 - start + h;
}

export interface PeriodWindowSpan {
  periodId: string;
  name: string;
  color: string;
  /** Inclusive start on the keyframe axis. */
  u0: number;
  /** Exclusive end on the keyframe axis. */
  u1: number;
}

/**
 * Day-cycle periods that overlap the lightning active window, as
 * contiguous spans on the keyframe timeline `u ∈ [0, 1]`.
 */
export function periodsCrossingActiveWindow(
  periods: DayPeriod[],
  startHour: number,
  endHour: number,
): PeriodWindowSpan[] {
  const duration = activeWindowDurationHours(startHour, endHour);
  if (duration <= 1e-9) return [];
  const windowSpans = linearHourSpans(startHour, endHour);
  const out: PeriodWindowSpan[] = [];
  for (const p of periods) {
    const periodSpans = linearHourSpans(p.startHour, p.endHour);
    for (const [wa, wb] of windowSpans) {
      for (const [pa, pb] of periodSpans) {
        const lo = Math.max(wa, pa);
        const hi = Math.min(wb, pb);
        if (hi - lo <= 1e-6) continue;
        const u0 = offsetHoursFromWindowStart(lo, startHour) / duration;
        const u1 = offsetHoursFromWindowStart(hi, startHour) / duration;
        if (u1 - u0 <= 1e-6) continue;
        out.push({
          periodId: p.id,
          name: p.name,
          color: p.color,
          u0: Math.max(0, Math.min(1, u0)),
          u1: Math.max(0, Math.min(1, u1)),
        });
      }
    }
  }
  out.sort((a, b) => a.u0 - b.u0 || a.u1 - b.u1);
  return out;
}

export interface WledParams {
  host: string;
  fps: number;
  enabled: boolean;
}

export interface SimState {
  ellipsoid: EllipsoidParams;
  cloud: CloudParams;
  cloudTop: CloudTopParams;
  strand: StrandParams;
  ambient: AmbientLightParams;
  directional: DirectionalLightParams;
  sky: SkyParams;
  wled: WledParams;
  lightning: LightningParams;
  dayCycle: DayCycleParams;
  ledDisplayMode: LedDisplayMode;
  ledStreamPipeline: LedStreamPipeline;
  ledLocator: LedLocatorState;
  mapping: MappingParams;
  mesh: MeshTargetParams;
  ui: UiParams;
  setEllipsoid: (e: Partial<EllipsoidParams>) => void;
  setCloud: (c: Partial<CloudParams>) => void;
  setCloudTop: (c: Partial<CloudTopParams>) => void;
  setStrand: (s: Partial<StrandParams>) => void;
  setAmbient: (a: Partial<AmbientLightParams>) => void;
  setDirectional: (d: Partial<DirectionalLightParams>) => void;
  setSky: (sk: Partial<SkyParams>) => void;
  setWled: (w: Partial<WledParams>) => void;
  setLightning: (l: Partial<LightningParams>) => void;
  setDayCycle: (patch: Partial<DayCycleParams>) => void;
  updateDayPeriod: (id: string, patch: Partial<DayPeriod>) => void;
  setActivePeriod: (id: string) => void;
  advancePeriod: () => void;
  previousPeriod: () => void;
  setLedDisplayMode: (mode: LedDisplayMode) => void;
  setLedStreamPipeline: (patch: Partial<LedStreamPipeline>) => void;
  setLedLocator: (patch: Partial<LedLocatorState>) => void;
  toggleLocatedLed: (index: number) => void;
  clearLocatedLeds: () => void;
  setMapping: (m: Partial<MappingParams>) => void;
  /** Switch the generated LED layout, rebuilding strand positions. */
  setLedLayout: (patch: {
    layout?: LedLayoutId;
    layoutPitch?: number;
    archPlacements?: [ArchPlacement, ArchPlacement];
  }) => void;
  setMesh: (m: Partial<MeshTargetParams>) => void;
  setUi: (u: Partial<UiParams>) => void;
  addMappedLed: (dir: Vec3, pos?: Vec3, normal?: Vec3) => void;
  moveMappedLed: (index: number, dir: Vec3, pos?: Vec3, normal?: Vec3) => void;
  updateMappedLed: (index: number, patch: Partial<MappedLed>) => void;
  removeLastMappedLed: () => void;
  clearMappedLeds: () => void;
  addMappingGaussian: (g: Omit<MappingGaussian, "id"> & { id?: string }) => void;
  updateMappingGaussian: (id: string, patch: Partial<MappingGaussian>) => void;
  removeMappingGaussian: (id: string) => void;
  /** Zero all per-LED offsets and remove every Gaussian bump. */
  clearMappingBumps: () => void;
}

export interface LedLocatorState {
  enabled: boolean;
  highlighted: number[];
  color: string;
}

/**
 * A single manually-placed LED in the mapping app. Its location is stored
 * as a unit-sphere direction so it stays glued to the ellipsoid surface
 * when the cloud dimensions change: the surface point is simply
 * `(rx, ry, rz) * dir`.
 */
export interface MappedLed {
  /**
   * Unit-sphere direction used in ellipsoid mode. In mesh mode a `dir` is
   * still stored (the normalised `pos` from origin) so the flip/orientation
   * helpers continue to work uniformly, but bead placement uses `pos`.
   */
  dir: Vec3;
  /** Mesh-local surface point on the uploaded mesh (mesh mode only). */
  pos?: Vec3;
  /** Outward-pointing surface normal at `pos` (mesh mode only). */
  normal?: Vec3;
  /**
   * Metres along the outward normal from the hand-placed surface point.
   * Does not mutate `pos`; applied at display / sim time. Default 0.
   */
  offset?: number;
}

/**
 * Persisted UI toggles for the floating panels on the simulator page.
 * Kept in the store (rather than component-local `useState`) so they
 * round-trip through the snapshot save/load like every other choice.
 */
export interface UiParams {
  showLightning: boolean;
  showTimeOfDay: boolean;
  showCloud: boolean;
  showStream: boolean;
}

export type MappingMode = "ellipsoid" | "mesh";

/** Active tool in the mapping app. */
export type MappingTool = "place" | "offset" | "gaussian";

/**
 * A compact smooth dome on the mesh surface. Legacy names are retained so
 * existing configuration files continue to load unchanged. It lifts nearby
 * LEDs and tilts normals from the dome slope.
 */
export interface MappingGaussian {
  id: string;
  /** Mesh-local surface point at the bump centre. */
  pos: Vec3;
  /** Outward surface normal at the centre (mesh-local). */
  normal: Vec3;
  /** Peak lift along the normal (metres). */
  amplitude: number;
  /** Tangential half-width of the elliptical falloff (metres). */
  width: number;
  /** Tangential half-height of the elliptical falloff (metres). */
  height: number;
  /** Rotation of the ellipse around the surface normal (degrees). */
  rotationDeg: number;
}

export interface MeshTargetParams {
  /** IndexedDB blob id, or null if no mesh is loaded. */
  id: string | null;
  /** Display name (usually the source filename). */
  name: string;
  /** Uniform scale applied to the imported mesh. */
  scale: number;
  /** Rotation around the vertical (Y) axis, degrees. */
  yawDeg: number;
  /** Rotation around the X axis, degrees. */
  tiltDeg: number;
  /** Vertical offset from origin, metres. */
  offsetY: number;
}

export interface MappingParams {
  /**
   * How the strand positions are produced. The slotted matrix is generated,
   * so the LEDs don't have to be placed by hand. "manual" keeps `leds` as
   * they were clicked onto the surface.
   */
  layout: LedLayoutId;
  /** LED pitch of the generated arches, in metres. Same along rows and columns. */
  layoutPitch: number;
  /** Independent layout-space position of each arch, in metres. */
  archPlacements: [ArchPlacement, ArchPlacement];
  /** LEDs in strand order. Generated from `layout`, or placed by hand. */
  leds: MappedLed[];
  /** Which surface the mapping app targets — the ellipsoid or an uploaded mesh. */
  mode: MappingMode;
  /** Active interaction tool in the mapping view. */
  tool: MappingTool;
  /** Mirror mapping orientation vertically (swap top/bottom). */
  flipUpDown: boolean;
  /** Mirror mapping orientation horizontally (swap left/right). */
  flipLeftRight: boolean;
  /**
   * When true, the logical sequence (LED numbering + the order streamed to
   * the simulator/WLED) is the reverse of the placement order — i.e. the
   * last-placed bead becomes #1. Flips which physical end counts as the
   * start of the string.
   */
  reversed: boolean;
  /** Bead display size in the mapping view (metres). */
  ledSize: number;
  /**
   * Maximum world-space distance the next LED can sit from the previous
   * one, in metres. Modelled as an upper bound on the length of each
   * strand segment: clicks farther than this from the last placed bead
   * are rejected and the hover preview turns red. Ignored for the first
   * bead in the strand.
   */
  maxSegmentLength: number;
  /** Show the 3D smooth-dome displacement surfaces in the mapping view. */
  showBumpSurfaces: boolean;
  /** Show mapped LEDs as full-size outward sensor hemispheres. */
  showBallSensors: boolean;
  /** Fraction of direct light blocked by smooth-dome surfaces, 0..1. */
  bumpLightOpacity: number;
  /** Fraction of direct light blocked by the pyramid mesh, 0..1. */
  pyramidLightOpacity: number;
  /** Blend from smooth max-union (0) to additive overlapping dome heights (1). */
  bumpAdditivity: number;
  /** Visual opacity of the mapping pyramid mesh. */
  meshSurfaceOpacity: number;
  /** Visual opacity of dome surfaces in mapping. */
  bumpSurfaceOpacity: number;
  /** Render the baked iso-surface preview in mapping. */
  showBakedSurface: boolean;
  /** Use baked iso-surface for bump occlusion in mapping/simulation. */
  useBakedSurface: boolean;
  /** Signature of the dome parameters used for the latest bake. */
  bakedSurfaceSignature: string | null;
  /** Increment to request a new baked surface build. */
  bakeSurfaceRequestNonce: number;
  /** Mapping-only inspection light orbit angle around the mesh. */
  mappingLightAngleDeg: number;
  /** Mapping-light vertical sweep: 0° above, 180° level, 360° below. */
  mappingLightElevationDeg: number;
  /** Mapping-only inspection light distance from the mesh centre. */
  mappingLightRadius: number;
  /** Mapping-only inspection light brightness. */
  mappingLightIntensity: number;
  /** Mapping-light angular response (same model as simulation sun/moon). */
  mappingLightSpread: number;
  /** Mapping-light radial beam falloff. */
  mappingLightFocus: number;
  /** Mapping-light distance falloff exponent. */
  mappingLightDecay: number;
  /** Mapping-only inspection light and streamed output colour. */
  mappingLightColor: string;
  /** Surface domes that lift / tilt nearby LEDs (legacy persisted name). */
  gaussians: MappingGaussian[];
}

/**
 * The default seed spread across the 24-hour day, per channel. The
 * sun channel emphasises daytime transitions (dawn → noon → sunset),
 * the moon channel emphasises night/twilight, and ambient covers the
 * whole cycle. Users can freely add, delete, and move stops in each
 * track after loading. Declared before `DEFAULTS` so it's out of the
 * temporal dead zone by the time `DEFAULTS` seeds itself.
 */
type ChannelSeed = Array<[number, string]>;

const SUN_SEED: ChannelSeed = [
  [4.5, "blueHour"],
  [6, "azureTwilight"],
  [6.75, "roseDawn"],
  [8, "goldenPeach"],
  [12, "noonSky"],
  [16, "warmDay"],
  [18.25, "emberSunset"],
  [19, "crimsonSunset"],
];

const MOON_SEED: ChannelSeed = [
  [0, "moonlitBlue"],
  [4.5, "blueHour"],
  [7, "roseDawn"],
  [18.5, "emberSunset"],
  [20.5, "violetDusk"],
  [22, "blueHour"],
];

const AMBIENT_SEED: ChannelSeed = [
  [0, "moonlitBlue"],
  [5, "blueHour"],
  [7, "roseDawn"],
  [12, "noonSky"],
  [17, "warmDay"],
  [19, "emberSunset"],
  [21, "violetDusk"],
];

function seedColorFromSwatch(channel: SkyChannel, swatchId: string): string {
  const s = getSwatch(swatchId);
  return channel === "sun"
    ? s.sunColor
    : channel === "moon"
      ? s.moonColor
      : s.ambientColor;
}

export function buildDefaultChannelStops(channel: SkyChannel): SkyChannelStop[] {
  const seed =
    channel === "sun" ? SUN_SEED : channel === "moon" ? MOON_SEED : AMBIENT_SEED;
  return seed.map(([hour, swatchId], i) => ({
    id: `${channel}-${i}-${swatchId}`,
    timeHours: hour,
    swatchId,
    color: seedColorFromSwatch(channel, swatchId),
  }));
}

const DEFAULTS = {
  ellipsoid: { rx: 1.2, ry: 0.8, rz: 1.0 } as EllipsoidParams,
  cloud: {
    opacity: 0.6,
    showOpacity: true,
    rotationXDeg: 0,
    rotationYDeg: 0,
    offsetX: 0,
    offsetY: 0,
    offsetZ: 0,
    applyLedOffset: true,
  } as CloudParams,
  cloudTop: {
    id: null,
    name: "",
    visible: true,
    scale: 1,
    yawDeg: 0,
    tiltDeg: 0,
    offsetX: 0,
    offsetY: 0,
    offsetZ: 0,
    tint: "#ffffff",
    glowStrength: 1.5,
    glowRadius: 0.25,
    glowFocus: 4,
  } as CloudTopParams,
  strand: {
    ledSize: 0.004,
    sensorHemisphereFocus: 0,
    colorProfile: { ...DEFAULT_LED_COLOR_PROFILE },
  } as StrandParams,
  ambient: {
    color: "#262830",
    intensity: 0.25,
    ducking: 0.75,
  } as AmbientLightParams,
  directional: {
    color: "#ffffff",
    intensity: 1.0,
    position: [3, 4, 2],
    spread: 1.0,
  } as DirectionalLightParams,
  sky: {
    enabled: true,
    visualizationAmount: 1,
    autoPlay: true,
    timeHours: 12,
    cycleSeconds: 180,
    ambientScale: 1,
    sunScale: 1,
    moonScale: 1,
    sunSpread: 0.9,
    moonSpread: 0.9,
    sunBeamFocus: 0.65,
    sunTopHighlightBoost: 0,
    moonBeamFocus: 0.65,
    lightDecay: 1,
    showSpreadCones: false,
    orbitRadius: 12,
    orbitRadiusX: 12,
    orbitRadiusY: 12,
    orbitRadiusZ: 12,
    sunHorizonStartDeg: -8,
    sunHorizonFullDeg: 3,
    moonHorizonStartDeg: -8,
    moonHorizonFullDeg: 3,
    sunStops: buildDefaultChannelStops("sun"),
    moonStops: buildDefaultChannelStops("moon"),
    ambientStops: buildDefaultChannelStops("ambient"),
  } as SkyParams,
  wled: { host: "192.168.1.50", fps: 30, enabled: false } as WledParams,
  lightning: {
    enabled: false,
    colors: buildDefaultLightningColors(),
    intensityRange: [0.9, 1.5],
    keyframes: [
      {
        id: "kf-0",
        t: 0,
        values: {
          intensityRange: [0.5, 0.9],
          strikesPerMinute: 2,
          strikePerMinute: 0.3,
          spritesPerMinute: 0.5,
          spriteStrobeDutyRange: [0.3, 0.6],
          subFlashes: 0.25,
          spanScale: 0.7,
          minSpanScale: 0.4,
          boltGain: 0.6,
          spriteGain: 1.2,
          backgroundGain: 0.25,
          thunderDelayMs: 800,
          pan: 0,
        },
      },
      {
        id: "kf-1",
        t: 0.5,
        values: {
          intensityRange: [0.9, 1.5],
          strikesPerMinute: 8,
          strikePerMinute: 1,
          spritesPerMinute: 2,
          spriteStrobeDutyRange: [0.2, 0.55],
          subFlashes: 0.4,
          spanScale: 0.85,
          minSpanScale: 0.5,
          boltGain: 0.8,
          spriteGain: 1.6,
          backgroundGain: 0.35,
          thunderDelayMs: 800,
          pan: 0,
        },
      },
      {
        id: "kf-2",
        t: 1,
        values: {
          intensityRange: [0.5, 0.9],
          strikesPerMinute: 2,
          strikePerMinute: 0.3,
          spritesPerMinute: 0.5,
          spriteStrobeDutyRange: [0.3, 0.6],
          subFlashes: 0.25,
          spanScale: 0.7,
          minSpanScale: 0.4,
          boltGain: 0.6,
          spriteGain: 1.2,
          backgroundGain: 0.25,
          thunderDelayMs: 800,
          pan: 0,
        },
      },
    ],
    strikesPerMinute: 2,
    strikePerMinute: 0.5,
    spritesPerMinute: 1,
    falloffDistance: 0.1,
    boltSegments: 10,
    boltJitterRange: [0.25, 0.55],
    travelSpeedRange: [0.5, 2],
    subFlashes: 0.4,
    spanScale: 0.85,
    minSpanScale: 0.5,
    activeStartHour: 20,
    activeEndHour: 4,
    boltSamples: [],
    strikeSample: null,
    backgroundSample: null,
    spriteAudioSamples: [],
    spriteSamples: [],
    spriteDurationMs: 180,
    spriteStrobeHz: 18,
    spriteStrobeDuty: 0.45,
    boltGain: 0.8,
    spriteGain: 1.4,
    spriteAudioGain: 1,
    spriteAudioReactiveBrightness: true,
    backgroundGain: 0.35,
    boltPitchJitterCents: 200,
    thunderDelayMs: 800,
    pan: 0,
    simFps: 60,
  } as LightningParams,
  dayCycle: {
    periods: [
      { id: "dawn", name: "Dawn", startHour: 5, endHour: 8, color: "#f472b6" },
      { id: "day", name: "Day", startHour: 8, endHour: 17, color: "#facc15" },
      { id: "dusk", name: "Dusk", startHour: 17, endHour: 20, color: "#fb923c" },
      { id: "night", name: "Night", startHour: 20, endHour: 0, color: "#6366f1" },
      {
        id: "magicalNight",
        name: "Magical night",
        startHour: 0,
        endHour: 5,
        color: "#c084fc",
      },
    ],
    activePeriodId: "dawn",
    autoNext: false,
  } as DayCycleParams,
  ledDisplayMode: "sensors" as LedDisplayMode,
  ledStreamPipeline: {
    timeOfDayStage: true,
    lightningStage: true,
    locatorOverrideStage: true,
  } as LedStreamPipeline,
  ledLocator: {
    enabled: false,
    highlighted: [],
    color: "#ffe14d",
  } as LedLocatorState,
  mapping: {
    layout: DUAL_32X8_SLOTTED,
    layoutPitch: DEFAULT_LAYOUT_PITCH,
    archPlacements: [
      { ...DEFAULT_ARCH_PLACEMENTS[0] },
      { ...DEFAULT_ARCH_PLACEMENTS[1] },
    ],
    leds: buildDual32x8Slotted(DEFAULT_LAYOUT_PITCH, DEFAULT_ARCH_PLACEMENTS),
    mode: "ellipsoid",
    tool: "offset",
    flipUpDown: false,
    flipLeftRight: false,
    reversed: false,
    ledSize: 0.002,
    maxSegmentLength: 0.05,
    showBumpSurfaces: false,
    showBallSensors: false,
    bumpLightOpacity: 1,
    pyramidLightOpacity: 1,
    bumpAdditivity: 0.2,
    meshSurfaceOpacity: 0.65,
    bumpSurfaceOpacity: 0.62,
    showBakedSurface: false,
    useBakedSurface: false,
    bakedSurfaceSignature: null,
    bakeSurfaceRequestNonce: 0,
    mappingLightAngleDeg: 45,
    mappingLightElevationDeg: 0,
    mappingLightRadius: 5,
    mappingLightIntensity: 1.5,
    mappingLightSpread: 0.9,
    mappingLightFocus: 0.65,
    mappingLightDecay: 1,
    mappingLightColor: "#fff3d0",
    gaussians: [],
  } as MappingParams,
  mesh: {
    id: null,
    name: "",
    scale: 1,
    yawDeg: 0,
    tiltDeg: 0,
    offsetY: 0,
  } as MeshTargetParams,
  ui: {
    showLightning: false,
    showTimeOfDay: false,
    showCloud: false,
    showStream: false,
  } as UiParams,
};

function channelsFromLegacyStops(
  stops: LegacyTriStop[],
): Pick<SkyParams, "sunStops" | "moonStops" | "ambientStops"> {
  const mk = (channel: SkyChannel): SkyChannelStop[] =>
    stops.map((s, i) => ({
      id: `${channel}-legacy-${i}-${s.id}`,
      timeHours: s.timeHours,
      swatchId: s.swatchId,
      color:
        channel === "sun"
          ? s.sunColor
          : channel === "moon"
            ? s.moonColor
            : s.ambientColor,
    }));
  return {
    sunStops: mk("sun"),
    moonStops: mk("moon"),
    ambientStops: mk("ambient"),
  };
}

/**
 * Older-still snapshots stored a fixed-phase palette. Convert it to
 * three independent channel timelines by iterating the phase → hour
 * mapping and pulling the matching channel color from each entry.
 */
function channelsFromLegacyPalette(
  palette: Record<string, { ambientColor?: string; sunColor?: string; moonColor?: string }>,
): Pick<SkyParams, "sunStops" | "moonStops" | "ambientStops"> {
  const phaseToHour: Record<string, number> = {
    night: 0,
    preDawn: 4.5,
    blueHour: 6,
    sunrise: 6.75,
    goldenHour: 8,
    day: 12,
    afternoon: 16,
    sunset: 18.5,
    twilight: 20,
  };
  const mk = (channel: SkyChannel): SkyChannelStop[] => {
    const out: SkyChannelStop[] = [];
    let i = 0;
    for (const [phaseId, hour] of Object.entries(phaseToHour)) {
      const p = palette[phaseId];
      if (!p) continue;
      const c =
        channel === "sun"
          ? p.sunColor
          : channel === "moon"
            ? p.moonColor
            : p.ambientColor;
      out.push({
        id: `${channel}-legacy-${i++}-${phaseId}`,
        timeHours: hour,
        swatchId: CUSTOM_SWATCH_ID,
        color: c ?? "#101828",
      });
    }
    return out;
  };
  const sun = mk("sun");
  return sun.length > 0
    ? { sunStops: sun, moonStops: mk("moon"), ambientStops: mk("ambient") }
    : {
        sunStops: buildDefaultChannelStops("sun"),
        moonStops: buildDefaultChannelStops("moon"),
        ambientStops: buildDefaultChannelStops("ambient"),
      };
}

/**
 * Resolve a saved sky payload (which may be from any historical schema
 * version) into three channel arrays. Preference order: existing
 * per-channel arrays → legacy `stops` list → older-still `palette` map
 * → hardcoded defaults.
 */
function resolveChannelStops(
  savedSky: Partial<SkyParams> & {
    stops?: LegacyTriStop[];
    palette?: Record<string, unknown>;
  },
): Pick<SkyParams, "sunStops" | "moonStops" | "ambientStops"> {
  let fallback: Pick<SkyParams, "sunStops" | "moonStops" | "ambientStops">;
  if (Array.isArray(savedSky.stops) && savedSky.stops.length > 0) {
    fallback = channelsFromLegacyStops(savedSky.stops);
  } else if (savedSky.palette && typeof savedSky.palette === "object") {
    fallback = channelsFromLegacyPalette(
      savedSky.palette as Record<
        string,
        { ambientColor?: string; sunColor?: string; moonColor?: string }
      >,
    );
  } else {
    fallback = {
      sunStops: DEFAULTS.sky.sunStops,
      moonStops: DEFAULTS.sky.moonStops,
      ambientStops: DEFAULTS.sky.ambientStops,
    };
  }
  return {
    sunStops: Array.isArray(savedSky.sunStops)
      ? savedSky.sunStops
      : fallback.sunStops,
    moonStops: Array.isArray(savedSky.moonStops)
      ? savedSky.moonStops
      : fallback.moonStops,
    ambientStops: Array.isArray(savedSky.ambientStops)
      ? savedSky.ambientStops
      : fallback.ambientStops,
  };
}

/**
 * Reconcile a saved `dayCycle` payload. Falls back to defaults for a
 * missing or malformed slice; unknown activeId → first period.
 * Migrates the legacy single Night (20→5) into Night + Magical night.
 */
function resolveDayCycle(
  saved: Partial<DayCycleParams> | undefined,
): DayCycleParams {
  if (!saved) return DEFAULTS.dayCycle;
  let periods: DayPeriod[] = Array.isArray(saved.periods) && saved.periods.length > 0
    ? saved.periods
        .filter((p): p is DayPeriod =>
          !!p &&
          typeof p.id === "string" &&
          typeof p.name === "string" &&
          typeof p.startHour === "number" &&
          typeof p.endHour === "number" &&
          typeof p.color === "string",
        )
        .map((p) => ({
          id: p.id,
          name: p.name,
          startHour: Math.max(0, Math.min(24, p.startHour)),
          endHour: Math.max(0, Math.min(24, p.endHour)),
          color: p.color,
        }))
    : DEFAULTS.dayCycle.periods;
  periods = migrateLegacyNightPeriod(periods);
  const activePeriodId =
    saved.activePeriodId && periods.some((p) => p.id === saved.activePeriodId)
      ? saved.activePeriodId
      : periods[0].id;
  const autoNext =
    typeof saved.autoNext === "boolean" ? saved.autoNext : DEFAULTS.dayCycle.autoNext;
  return { periods, activePeriodId, autoNext };
}

/**
 * If the saved cycle still has a single Night spanning 20→5 (and no
 * Magical night yet), split it into Night 20→0 and Magical night 0→5.
 */
function migrateLegacyNightPeriod(periods: DayPeriod[]): DayPeriod[] {
  if (periods.some((p) => p.id === "magicalNight")) return periods;
  const nightIdx = periods.findIndex((p) => p.id === "night");
  if (nightIdx < 0) return periods;
  const night = periods[nightIdx];
  // Only rewrite the classic default span; leave custom night ranges alone.
  const isLegacySpan =
    Math.abs(night.startHour - 20) < 1e-6 && Math.abs(night.endHour - 5) < 1e-6;
  if (!isLegacySpan) return periods;
  const next = [...periods];
  next[nightIdx] = {
    ...night,
    name: night.name || "Night",
    startHour: 20,
    endHour: 0,
  };
  next.splice(nightIdx + 1, 0, {
    id: "magicalNight",
    name: "Magical night",
    startHour: 0,
    endHour: 5,
    color: "#c084fc",
  });
  return next;
}

/**
 * Reconcile a saved `lightning` payload. Any missing range field is
 * back-filled from its legacy scalar so previously-saved snapshots
 * (before the ranges existed) keep working with sensible values.
 */
function cloneColorStop(s: LightningColorStop): LightningColorStop {
  return { id: s.id, t: s.t, color: s.color };
}

function cloneColorStops(list: LightningColorStop[]): LightningColorStop[] {
  return list.map(cloneColorStop);
}

export function cloneColorTracks(
  t: LightningColorTracks,
): LightningColorTracks {
  return {
    main: cloneColorStops(t.main),
    highlight1: cloneColorStops(t.highlight1),
    highlight2: cloneColorStops(t.highlight2),
  };
}

function resolveColorStops(
  input: unknown,
  fallback: LightningColorStop[],
): LightningColorStop[] {
  if (!Array.isArray(input) || input.length === 0) {
    return cloneColorStops(fallback);
  }
  const out: LightningColorStop[] = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.color !== "string") continue;
    const t =
      typeof rec.t === "number" && Number.isFinite(rec.t)
        ? Math.max(0, Math.min(1, rec.t))
        : typeof rec.timeHours === "number" && Number.isFinite(rec.timeHours)
          ? Math.max(0, Math.min(1, rec.timeHours / 24))
          : NaN;
    if (!Number.isFinite(t)) continue;
    const id =
      typeof rec.id === "string" && rec.id.length > 0
        ? rec.id
        : `lcs-${i}-${Math.random().toString(36).slice(2, 6)}`;
    out.push({ id, t, color: rec.color });
  }
  return out.length > 0 ? out : cloneColorStops(fallback);
}

function resolveColorTracks(
  input: unknown,
  fallback: LightningColorTracks,
): LightningColorTracks {
  if (!input || typeof input !== "object") return cloneColorTracks(fallback);
  const rec = input as Record<string, unknown>;
  return {
    main: resolveColorStops(rec.main, fallback.main),
    highlight1: resolveColorStops(rec.highlight1, fallback.highlight1),
    highlight2: resolveColorStops(rec.highlight2, fallback.highlight2),
  };
}

function trackFromStaticPalette(palette: LightningPalette): LightningColorTracks {
  return {
    main: channelStopsPair(palette[0], palette[0]),
    highlight1: channelStopsPair(palette[1], palette[1]),
    highlight2: channelStopsPair(palette[2], palette[2]),
  };
}

/**
 * Prefer `colors`; migrate legacy `paletteTracks` / `palettes` / trio
 * `colors` so old snapshots keep working.
 */
function resolveLightningColors(
  saved: Record<string, unknown>,
  fallbackColors: LightningColorTracks,
): LightningColorTracks {
  if (saved.colors && typeof saved.colors === "object" && !Array.isArray(saved.colors)) {
    return resolveColorTracks(saved.colors, fallbackColors);
  }
  if (Array.isArray(saved.paletteTracks) && saved.paletteTracks[0]) {
    return resolveColorTracks(saved.paletteTracks[0], fallbackColors);
  }
  if (Array.isArray(saved.palettes) && saved.palettes[0]) {
    const p = saved.palettes[0];
    if (
      Array.isArray(p) &&
      p.length === 3 &&
      typeof p[0] === "string" &&
      typeof p[1] === "string" &&
      typeof p[2] === "string"
    ) {
      return trackFromStaticPalette([p[0], p[1], p[2]]);
    }
  }
  if (
    Array.isArray(saved.color) &&
    saved.color.length === 3 &&
    typeof saved.color[0] === "string"
  ) {
    return trackFromStaticPalette([
      saved.color[0] as string,
      saved.color[1] as string,
      saved.color[2] as string,
    ]);
  }
  return cloneColorTracks(fallbackColors);
}

function cloneAnimParams(src: LightningAnimParams): LightningAnimParams {
  return {
    intensityRange: [src.intensityRange[0], src.intensityRange[1]],
    strikesPerMinute: src.strikesPerMinute,
    strikePerMinute: src.strikePerMinute,
    spritesPerMinute: src.spritesPerMinute,
    spriteStrobeDutyRange: [
      src.spriteStrobeDutyRange[0],
      src.spriteStrobeDutyRange[1],
    ],
    subFlashes: src.subFlashes,
    spanScale: src.spanScale,
    minSpanScale: src.minSpanScale,
    boltGain: src.boltGain,
    spriteGain: src.spriteGain,
    backgroundGain: src.backgroundGain,
    thunderDelayMs: src.thunderDelayMs,
    pan: src.pan,
  };
}

/**
 * `subFlashes` used to be an integer flicker count (0–4). Values above 1
 * are treated as legacy and remapped onto [0, 1] via `/4`.
 */
function migrateSubFlashes(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v > 1) return Math.min(1, v / 4);
  return Math.max(0, Math.min(1, v));
}

function animParamsFromRoot(p: {
  intensityRange: [number, number];
  strikesPerMinute: number;
  strikePerMinute: number;
  spritesPerMinute: number;
  spriteStrobeDutyRange: [number, number];
  subFlashes: number;
  spanScale: number;
  minSpanScale: number;
  boltGain: number;
  spriteGain: number;
  backgroundGain: number;
  thunderDelayMs: number;
  pan: number;
}): LightningAnimParams {
  return cloneAnimParams(p);
}

function scaleIntensityRange(
  base: [number, number],
  scale: number,
): [number, number] {
  const s = Math.max(0, scale);
  return [base[0] * s, base[1] * s];
}

function resolveAnimParams(
  input: unknown,
  fallback: LightningAnimParams,
): LightningAnimParams {
  if (!input || typeof input !== "object") return cloneAnimParams(fallback);
  const rec = input as Record<string, unknown>;
  const intensityRange = (() => {
    const v = rec.intensityRange;
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      typeof v[0] === "number" &&
      typeof v[1] === "number"
    ) {
      return [Math.min(v[0], v[1]), Math.max(v[0], v[1])] as [number, number];
    }
    return fallback.intensityRange;
  })();
  const spriteStrobeDutyRange = (() => {
    const v = rec.spriteStrobeDutyRange;
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      typeof v[0] === "number" &&
      typeof v[1] === "number"
    ) {
      const lo = Math.max(0.05, Math.min(0.95, Math.min(v[0], v[1])));
      const hi = Math.max(lo, Math.min(0.95, Math.max(v[0], v[1])));
      return [lo, hi] as [number, number];
    }
    const legacy = rec.spriteStrobeDuty;
    if (typeof legacy === "number" && Number.isFinite(legacy)) {
      const duty = Math.max(0.05, Math.min(0.95, legacy));
      return [duty, duty] as [number, number];
    }
    return fallback.spriteStrobeDutyRange;
  })();
  const num = (v: unknown, fb: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fb;
  const spanScale = Math.max(0, Math.min(1, num(rec.spanScale, fallback.spanScale)));
  const minSpanScale = Math.max(
    0,
    Math.min(spanScale, num(rec.minSpanScale, fallback.minSpanScale)),
  );
  return {
    intensityRange,
    strikesPerMinute: Math.max(
      0,
      Math.min(40, num(rec.strikesPerMinute, fallback.strikesPerMinute)),
    ),
    strikePerMinute: Math.max(
      0,
      Math.min(40, num(rec.strikePerMinute, fallback.strikePerMinute)),
    ),
    spritesPerMinute: Math.max(
      0,
      Math.min(40, num(rec.spritesPerMinute, fallback.spritesPerMinute)),
    ),
    spriteStrobeDutyRange,
    subFlashes: migrateSubFlashes(num(rec.subFlashes, fallback.subFlashes)),
    spanScale,
    minSpanScale,
    boltGain: Math.max(0, Math.min(3, num(rec.boltGain, fallback.boltGain))),
    spriteGain: Math.max(0, Math.min(3, num(rec.spriteGain, fallback.spriteGain))),
    backgroundGain: Math.max(
      0,
      Math.min(3, num(rec.backgroundGain, fallback.backgroundGain)),
    ),
    thunderDelayMs: Math.max(
      0,
      Math.min(2000, num(rec.thunderDelayMs, fallback.thunderDelayMs)),
    ),
    pan: Math.max(-1, Math.min(1, num(rec.pan, fallback.pan))),
  };
}

function resolveLightningKeyframes(
  input: unknown,
  legacyEnvelope: unknown,
  fallback: LightningKeyframe[],
  rootAnim: LightningAnimParams,
): LightningKeyframe[] {
  if (Array.isArray(input) && input.length >= 2) {
    const out: LightningKeyframe[] = [];
    for (let i = 0; i < input.length; i++) {
      const raw = input[i];
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      const t = typeof rec.t === "number" && Number.isFinite(rec.t) ? rec.t : NaN;
      if (!Number.isFinite(t)) continue;
      const id =
        typeof rec.id === "string" && rec.id.length > 0
          ? rec.id
          : `kf-${i}-${Math.random().toString(36).slice(2, 7)}`;
      out.push({
        id,
        t: Math.max(0, Math.min(1, t)),
        values: resolveAnimParams(rec.values, rootAnim),
      });
    }
    if (out.length >= 2) {
      out.sort((a, b) => a.t - b.t);
      return out;
    }
  }
  // Migrate intensityEnvelope → keyframes scaling intensityRange by value.
  if (Array.isArray(legacyEnvelope) && legacyEnvelope.length >= 2) {
    const out: LightningKeyframe[] = [];
    for (let i = 0; i < legacyEnvelope.length; i++) {
      const raw = legacyEnvelope[i];
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      const t = typeof rec.t === "number" && Number.isFinite(rec.t) ? rec.t : NaN;
      const value =
        typeof rec.value === "number" && Number.isFinite(rec.value)
          ? rec.value
          : NaN;
      if (!Number.isFinite(t) || !Number.isFinite(value)) continue;
      const id =
        typeof rec.id === "string" && rec.id.length > 0
          ? rec.id
          : `kf-mig-${i}`;
      const values = cloneAnimParams(rootAnim);
      values.intensityRange = scaleIntensityRange(rootAnim.intensityRange, value);
      out.push({ id, t: Math.max(0, Math.min(1, t)), values });
    }
    if (out.length >= 2) {
      out.sort((a, b) => a.t - b.t);
      return out;
    }
  }
  return fallback.map((k) => ({
    id: k.id,
    t: k.t,
    values: cloneAnimParams(k.values),
  }));
}

function resolveIntensityTags(input: unknown): BoltIntensityTag[] {
  if (!Array.isArray(input)) return [];
  const out: BoltIntensityTag[] = [];
  for (const v of input) {
    if (v === "low" || v === "medium" || v === "high") {
      if (!out.includes(v)) out.push(v);
    }
  }
  return out;
}

function resolveLengthTags(input: unknown): BoltLengthTag[] {
  if (!Array.isArray(input)) return [];
  const out: BoltLengthTag[] = [];
  for (const v of input) {
    if (v === "short" || v === "medium" || v === "long") {
      if (!out.includes(v)) out.push(v);
    }
  }
  return out;
}

export function resolveLightningSample(
  input: Record<string, unknown>,
): LightningSample | null {
  if (typeof input.id !== "string" || !input.id) return null;
  if (typeof input.name !== "string") return null;
  const durationSec =
    typeof input.durationSec === "number" && Number.isFinite(input.durationSec)
      ? input.durationSec
      : undefined;
  const gain =
    typeof input.gain === "number" && Number.isFinite(input.gain)
      ? Math.max(0, Math.min(1, input.gain))
      : 1;
  return {
    id: input.id,
    name: input.name,
    ...(durationSec !== undefined ? { durationSec } : {}),
    gain,
    intensityTags: resolveIntensityTags(input.intensityTags),
    lengthTags: resolveLengthTags(input.lengthTags),
  };
}

function resolveLightningSamples(input: unknown): LightningSample[] {
  if (!Array.isArray(input)) return [];
  const out: LightningSample[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const s = resolveLightningSample(raw as Record<string, unknown>);
    if (s) out.push(s);
  }
  return out;
}

export function resolveLightningSpriteSample(
  input: Record<string, unknown>,
): LightningSpriteSample | null {
  if (typeof input.id !== "string" || !input.id) return null;
  if (typeof input.name !== "string") return null;
  const width =
    typeof input.width === "number" && Number.isFinite(input.width)
      ? Math.max(1, Math.floor(input.width))
      : undefined;
  const height =
    typeof input.height === "number" && Number.isFinite(input.height)
      ? Math.max(1, Math.floor(input.height))
      : undefined;
  return {
    id: input.id,
    name: input.name,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

function resolveLightningSpriteSamples(input: unknown): LightningSpriteSample[] {
  if (!Array.isArray(input)) return [];
  const out: LightningSpriteSample[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const s = resolveLightningSpriteSample(raw as Record<string, unknown>);
    if (s) out.push(s);
  }
  return out;
}

function resolveLightning(input: unknown): LightningParams {
  const d = DEFAULTS.lightning;
  if (!input || typeof input !== "object") return d;
  const saved = input as Partial<LightningParams> & Record<string, unknown>;
  const asPair = (
    v: unknown,
    fallback: [number, number],
  ): [number, number] => {
    if (Array.isArray(v) && v.length === 2 &&
        typeof v[0] === "number" && typeof v[1] === "number") {
      return [Math.min(v[0], v[1]), Math.max(v[0], v[1])];
    }
    return fallback;
  };
  const asPairFromScalar = (
    rangeKey: keyof LightningParams,
    legacyKey: string,
    fallback: [number, number],
  ): [number, number] => {
    const explicit = (saved as Record<string, unknown>)[rangeKey as string];
    if (Array.isArray(explicit)) return asPair(explicit, fallback);
    const scalar = (saved as Record<string, unknown>)[legacyKey];
    if (typeof scalar === "number") return [scalar, scalar];
    return fallback;
  };
  return {
    ...d,
    ...saved,
    colors: resolveLightningColors(
      saved as Record<string, unknown>,
      d.colors,
    ),
    intensityRange: asPairFromScalar(
      "intensityRange",
      "intensity",
      d.intensityRange,
    ),
    strikesPerMinute: (() => {
      const v =
        typeof saved.strikesPerMinute === "number"
          ? saved.strikesPerMinute
          : d.strikesPerMinute;
      return Math.max(0, Math.min(40, v));
    })(),
    strikePerMinute: (() => {
      const v =
        typeof saved.strikePerMinute === "number"
          ? saved.strikePerMinute
          : d.strikePerMinute;
      return Math.max(0, Math.min(40, v));
    })(),
    spritesPerMinute: (() => {
      const v =
        typeof saved.spritesPerMinute === "number"
          ? saved.spritesPerMinute
          : d.spritesPerMinute;
      return Math.max(0, Math.min(40, v));
    })(),
    keyframes: (() => {
      const intensityRange = asPairFromScalar(
        "intensityRange",
        "intensity",
        d.intensityRange,
      );
      const rootAnim = animParamsFromRoot({
        intensityRange,
        strikesPerMinute:
          typeof saved.strikesPerMinute === "number"
            ? saved.strikesPerMinute
            : d.strikesPerMinute,
        strikePerMinute:
          typeof saved.strikePerMinute === "number"
            ? saved.strikePerMinute
            : d.strikePerMinute,
        spritesPerMinute:
          typeof saved.spritesPerMinute === "number"
            ? saved.spritesPerMinute
            : d.spritesPerMinute,
        spriteStrobeDutyRange: [
          typeof saved.spriteStrobeDuty === "number"
            ? Math.max(0.05, Math.min(0.95, saved.spriteStrobeDuty))
            : d.spriteStrobeDuty,
          typeof saved.spriteStrobeDuty === "number"
            ? Math.max(0.05, Math.min(0.95, saved.spriteStrobeDuty))
            : d.spriteStrobeDuty,
        ],
        subFlashes: migrateSubFlashes(
          typeof saved.subFlashes === "number" ? saved.subFlashes : d.subFlashes,
        ),
        spanScale:
          typeof saved.spanScale === "number" ? saved.spanScale : d.spanScale,
        minSpanScale:
          typeof saved.minSpanScale === "number"
            ? saved.minSpanScale
            : d.minSpanScale,
        boltGain: typeof saved.boltGain === "number" ? saved.boltGain : d.boltGain,
        spriteGain:
          typeof saved.spriteGain === "number" ? saved.spriteGain : d.spriteGain,
        backgroundGain:
          typeof saved.backgroundGain === "number"
            ? saved.backgroundGain
            : d.backgroundGain,
        thunderDelayMs:
          typeof saved.thunderDelayMs === "number"
            ? saved.thunderDelayMs
            : d.thunderDelayMs,
        pan: typeof saved.pan === "number" ? saved.pan : d.pan,
      });
      return resolveLightningKeyframes(
        (saved as Record<string, unknown>).keyframes,
        (saved as Record<string, unknown>).intensityEnvelope,
        d.keyframes,
        rootAnim,
      );
    })(),
    falloffDistance: (() => {
      const rec = saved as Record<string, unknown>;
      const clamp = (v: number) => Math.max(0, Math.min(0.2, v));
      const explicit = rec.falloffDistance;
      if (typeof explicit === "number" && Number.isFinite(explicit)) {
        return clamp(explicit);
      }
      // Migration from the old fixed-radius model.
      const legacy = rec.boltRadius;
      if (typeof legacy === "number" && Number.isFinite(legacy)) {
        return clamp(legacy);
      }
      const range = rec.boltRadiusRange;
      if (
        Array.isArray(range) &&
        typeof range[0] === "number" &&
        typeof range[1] === "number"
      ) {
        return clamp((range[0] + range[1]) / 2);
      }
      return d.falloffDistance;
    })(),
    boltJitterRange: asPairFromScalar(
      "boltJitterRange",
      "boltJitter",
      d.boltJitterRange,
    ),
    travelSpeedRange: asPairFromScalar(
      "travelSpeedRange",
      "travelSpeed",
      d.travelSpeedRange,
    ),
    subFlashes: migrateSubFlashes(
      typeof saved.subFlashes === "number" ? saved.subFlashes : d.subFlashes,
    ),
    thunderDelayMs: (() => {
      const v = (saved as Record<string, unknown>).thunderDelayMs;
      if (typeof v !== "number" || !Number.isFinite(v)) return d.thunderDelayMs;
      return Math.max(0, Math.min(2000, v));
    })(),
    pan: (() => {
      const v = (saved as Record<string, unknown>).pan;
      if (typeof v !== "number" || !Number.isFinite(v)) return d.pan;
      return Math.max(-1, Math.min(1, v));
    })(),
    boltSamples: resolveLightningSamples(
      (saved as Record<string, unknown>).boltSamples,
    ),
    strikeSample: (() => {
      const raw = (saved as Record<string, unknown>).strikeSample;
      if (!raw || typeof raw !== "object") return null;
      return resolveLightningSample(raw as Record<string, unknown>);
    })(),
    backgroundSample: (() => {
      const raw = (saved as Record<string, unknown>).backgroundSample;
      if (!raw || typeof raw !== "object") return null;
      return resolveLightningSample(raw as Record<string, unknown>);
    })(),
    spriteAudioSamples: (() => {
      const modern = resolveLightningSamples(
        (saved as Record<string, unknown>).spriteAudioSamples,
      );
      if (modern.length > 0) return modern;
      const legacy = (saved as Record<string, unknown>).spriteSample;
      if (!legacy || typeof legacy !== "object") return [];
      const migrated = resolveLightningSample(
        legacy as Record<string, unknown>,
      );
      return migrated ? [migrated] : [];
    })(),
    spriteSamples: resolveLightningSpriteSamples(
      (saved as Record<string, unknown>).spriteSamples,
    ),
    spriteDurationMs: (() => {
      const v = (saved as Record<string, unknown>).spriteDurationMs;
      if (typeof v !== "number" || !Number.isFinite(v)) return d.spriteDurationMs;
      return Math.max(20, Math.min(3000, v));
    })(),
    spriteStrobeHz: (() => {
      const v = (saved as Record<string, unknown>).spriteStrobeHz;
      if (typeof v !== "number" || !Number.isFinite(v)) return d.spriteStrobeHz;
      return Math.max(1, Math.min(60, v));
    })(),
    spriteStrobeDuty: (() => {
      const v = (saved as Record<string, unknown>).spriteStrobeDuty;
      if (typeof v !== "number" || !Number.isFinite(v)) return d.spriteStrobeDuty;
      return Math.max(0.05, Math.min(0.95, v));
    })(),
    spriteGain: (() => {
      const v = (saved as Record<string, unknown>).spriteGain;
      if (typeof v !== "number" || !Number.isFinite(v)) return d.spriteGain;
      return Math.max(0, Math.min(3, v));
    })(),
    spriteAudioGain: (() => {
      const rec = saved as Record<string, unknown>;
      const v =
        typeof rec.spriteAudioGain === "number"
          ? rec.spriteAudioGain
          : rec.spriteGain;
      if (typeof v !== "number" || !Number.isFinite(v)) return d.spriteAudioGain;
      return Math.max(0, Math.min(3, v));
    })(),
    spriteAudioReactiveBrightness:
      typeof (saved as Record<string, unknown>).spriteAudioReactiveBrightness ===
      "boolean"
        ? ((saved as Record<string, unknown>)
            .spriteAudioReactiveBrightness as boolean)
        : d.spriteAudioReactiveBrightness,
    boltPitchJitterCents: (() => {
      const v = (saved as Record<string, unknown>).boltPitchJitterCents;
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return d.boltPitchJitterCents;
      }
      return Math.max(0, Math.min(1200, v));
    })(),
  };
}

/** Clamp / normalise a saved mapping slice (tool, per-LED offsets). */
function resolveMapping(input: unknown): MappingParams {
  const d = DEFAULTS.mapping;
  if (!input || typeof input !== "object") return d;
  const saved = input as Partial<MappingParams> & Record<string, unknown>;
  const tool: MappingTool =
    saved.tool === "offset" ||
    saved.tool === "place" ||
    saved.tool === "gaussian"
      ? saved.tool
      : d.tool;
  const layout: LedLayoutId =
    saved.layout === "manual" || saved.layout === DUAL_32X8_SLOTTED
      ? saved.layout
      : Array.isArray(saved.leds) && saved.leds.length > 0
        ? "manual"
        : d.layout;
  const layoutPitch =
    typeof saved.layoutPitch === "number" && Number.isFinite(saved.layoutPitch)
      ? Math.max(0.004, Math.min(0.02, saved.layoutPitch))
      : d.layoutPitch;
  const rawLeds = Array.isArray(saved.leds) ? saved.leds : d.leds;
  const savedLeds: MappedLed[] = rawLeds.map((led) => {
    const l = (led ?? {}) as MappedLed;
    const offset =
      typeof l.offset === "number" && Number.isFinite(l.offset)
        ? Math.max(0, Math.min(0.5, l.offset))
        : 0;
    return { ...l, offset };
  });
  const archPlacements = resolveArchPlacements(saved.archPlacements);
  const leds =
    layout === DUAL_32X8_SLOTTED
      ? buildDual32x8Slotted(layoutPitch, archPlacements).map((led, i) => ({
          ...led,
          offset: savedLeds[i]?.offset ?? 0,
        }))
      : savedLeds;
  const rawGauss = Array.isArray(saved.gaussians) ? saved.gaussians : d.gaussians;
  const gaussians: MappingGaussian[] = [];
  for (let i = 0; i < rawGauss.length; i++) {
    const g = (rawGauss[i] ?? {}) as Partial<MappingGaussian>;
    const pos = Array.isArray(g.pos) && g.pos.length === 3
      ? ([g.pos[0], g.pos[1], g.pos[2]] as Vec3)
      : null;
    const normal = Array.isArray(g.normal) && g.normal.length === 3
      ? ([g.normal[0], g.normal[1], g.normal[2]] as Vec3)
      : null;
    if (!pos || !normal) continue;
    const amplitude =
      typeof g.amplitude === "number" && Number.isFinite(g.amplitude)
        ? Math.max(0, Math.min(0.5, g.amplitude))
        : 0.05;
    const legacySigma =
      typeof (g as { sigma?: number }).sigma === "number" &&
      Number.isFinite((g as { sigma?: number }).sigma)
        ? Math.max(0.005, Math.min(0.5, (g as { sigma: number }).sigma))
        : 0.08;
    const width =
      typeof g.width === "number" && Number.isFinite(g.width)
        ? Math.max(0.005, Math.min(0.5, g.width))
        : legacySigma;
    const height =
      typeof g.height === "number" && Number.isFinite(g.height)
        ? Math.max(0.005, Math.min(0.5, g.height))
        : legacySigma;
    let rotationDeg =
      typeof g.rotationDeg === "number" && Number.isFinite(g.rotationDeg)
        ? g.rotationDeg
        : 0;
    rotationDeg = ((rotationDeg % 360) + 360) % 360;
    gaussians.push({
      id:
        typeof g.id === "string" && g.id
          ? g.id
          : `gaussian-${i}-${Date.now().toString(36)}`,
      pos,
      normal,
      amplitude,
      width,
      height,
      rotationDeg,
    });
  }
  return {
    ...d,
    ...saved,
    tool,
    layout,
    layoutPitch,
    archPlacements,
    leds,
    gaussians,
    ledSize:
      typeof saved.ledSize === "number" && Number.isFinite(saved.ledSize)
        ? saved.ledSize
        : d.ledSize,
    maxSegmentLength:
      typeof saved.maxSegmentLength === "number" &&
      Number.isFinite(saved.maxSegmentLength)
        ? saved.maxSegmentLength
        : d.maxSegmentLength,
    showBumpSurfaces:
      typeof saved.showBumpSurfaces === "boolean"
        ? saved.showBumpSurfaces
        : d.showBumpSurfaces,
    showBallSensors:
      typeof saved.showBallSensors === "boolean"
        ? saved.showBallSensors
        : d.showBallSensors,
    bumpLightOpacity:
      typeof saved.bumpLightOpacity === "number" &&
      Number.isFinite(saved.bumpLightOpacity)
        ? Math.max(0, Math.min(1, saved.bumpLightOpacity))
        : d.bumpLightOpacity,
    pyramidLightOpacity:
      typeof saved.pyramidLightOpacity === "number" &&
      Number.isFinite(saved.pyramidLightOpacity)
        ? Math.max(0, Math.min(1, saved.pyramidLightOpacity))
        : d.pyramidLightOpacity,
    bumpAdditivity:
      typeof saved.bumpAdditivity === "number" &&
      Number.isFinite(saved.bumpAdditivity)
        ? Math.max(0, Math.min(1, saved.bumpAdditivity))
        : d.bumpAdditivity,
    meshSurfaceOpacity:
      typeof saved.meshSurfaceOpacity === "number" &&
      Number.isFinite(saved.meshSurfaceOpacity)
        ? Math.max(0, Math.min(1, saved.meshSurfaceOpacity))
        : d.meshSurfaceOpacity,
    bumpSurfaceOpacity:
      typeof saved.bumpSurfaceOpacity === "number" &&
      Number.isFinite(saved.bumpSurfaceOpacity)
        ? Math.max(0, Math.min(1, saved.bumpSurfaceOpacity))
        : d.bumpSurfaceOpacity,
    showBakedSurface:
      typeof saved.showBakedSurface === "boolean"
        ? saved.showBakedSurface
        : d.showBakedSurface,
    useBakedSurface:
      typeof saved.useBakedSurface === "boolean"
        ? saved.useBakedSurface
        : d.useBakedSurface,
    bakedSurfaceSignature:
      typeof saved.bakedSurfaceSignature === "string"
        ? saved.bakedSurfaceSignature
        : null,
    bakeSurfaceRequestNonce: 0,
    mappingLightAngleDeg:
      typeof saved.mappingLightAngleDeg === "number"
        ? saved.mappingLightAngleDeg
        : d.mappingLightAngleDeg,
    mappingLightElevationDeg:
      typeof saved.mappingLightElevationDeg === "number"
        ? ((saved.mappingLightElevationDeg % 360) + 360) % 360
        : typeof (saved as Record<string, unknown>).mappingLightHeight === "number"
          ? Math.asin(
              Math.max(
                -1,
                Math.min(
                  1,
                  ((saved as Record<string, number>).mappingLightHeight ?? 0) / 5,
                ),
              ),
            ) *
            (180 / Math.PI)
          : d.mappingLightElevationDeg,
    mappingLightRadius:
      typeof saved.mappingLightRadius === "number" &&
      Number.isFinite(saved.mappingLightRadius)
        ? Math.max(0.25, Math.min(20, saved.mappingLightRadius))
        : d.mappingLightRadius,
    mappingLightIntensity:
      typeof saved.mappingLightIntensity === "number"
        ? saved.mappingLightIntensity
        : d.mappingLightIntensity,
    mappingLightSpread:
      typeof saved.mappingLightSpread === "number"
        ? Math.max(0, Math.min(1, saved.mappingLightSpread))
        : d.mappingLightSpread,
    mappingLightFocus:
      typeof saved.mappingLightFocus === "number"
        ? Math.max(0, Math.min(1, saved.mappingLightFocus))
        : d.mappingLightFocus,
    mappingLightDecay:
      typeof saved.mappingLightDecay === "number"
        ? Math.max(0, Math.min(2, saved.mappingLightDecay))
        : d.mappingLightDecay,
    mappingLightColor:
      typeof saved.mappingLightColor === "string" &&
      /^#[0-9a-f]{6}$/i.test(saved.mappingLightColor)
        ? saved.mappingLightColor
        : d.mappingLightColor,
    flipUpDown: typeof saved.flipUpDown === "boolean" ? saved.flipUpDown : d.flipUpDown,
    flipLeftRight:
      typeof saved.flipLeftRight === "boolean" ? saved.flipLeftRight : d.flipLeftRight,
    reversed: typeof saved.reversed === "boolean" ? saved.reversed : d.reversed,
    mode: saved.mode === "mesh" || saved.mode === "ellipsoid" ? saved.mode : d.mode,
  };
}

/** Seed the store from a localStorage snapshot if one exists. */
function initialState() {
  const saved = loadSnapshot();
  if (!saved) return DEFAULTS;
  const savedSky = (saved.sky ?? {}) as Partial<SkyParams> & {
    stops?: LegacyTriStop[];
    palette?: Record<string, unknown>;
  };
  const channels = resolveChannelStops(savedSky);
  return {
    ellipsoid: { ...DEFAULTS.ellipsoid, ...saved.ellipsoid },
    cloud: { ...DEFAULTS.cloud, ...saved.cloud },
    cloudTop: { ...DEFAULTS.cloudTop, ...(saved.cloudTop ?? {}) },
    strand: {
      ...DEFAULTS.strand,
      ...saved.strand,
      colorProfile: resolveLedColorProfile(saved.strand?.colorProfile),
    },
    ambient: { ...DEFAULTS.ambient, ...saved.ambient },
    directional: { ...DEFAULTS.directional, ...saved.directional },
    sky: {
      ...DEFAULTS.sky,
      ...savedSky,
      ...channels,
    },
    // Don't auto-resume streaming on page load: if the user reopens the app
    // they probably don't want it immediately blasting UDP to the strip.
    wled: { ...DEFAULTS.wled, ...saved.wled, enabled: false },
    lightning: resolveLightning(saved.lightning),
    dayCycle: resolveDayCycle(saved.dayCycle),
    ledDisplayMode:
      saved.ledDisplayMode === "leds" || saved.ledDisplayMode === "sensors"
        ? saved.ledDisplayMode
        : DEFAULTS.ledDisplayMode,
    ledStreamPipeline: {
      ...DEFAULTS.ledStreamPipeline,
      ...saved.ledStreamPipeline,
    },
    ledLocator: { ...DEFAULTS.ledLocator, ...saved.ledLocator },
    mapping: resolveMapping(saved.mapping),
    mesh: { ...DEFAULTS.mesh, ...(saved.mesh ?? {}) },
    ui: { ...DEFAULTS.ui, ...(saved.ui ?? {}) },
  };
}

export const useSimStore = create<SimState>((set) => ({
  ...initialState(),
  setEllipsoid: (e) => set((s) => ({ ellipsoid: { ...s.ellipsoid, ...e } })),
  setCloud: (c) => set((s) => ({ cloud: { ...s.cloud, ...c } })),
  setCloudTop: (c) =>
    set((s) => ({ cloudTop: { ...s.cloudTop, ...c } })),
  setStrand: (st) => set((s) => ({ strand: { ...s.strand, ...st } })),
  setAmbient: (a) => set((s) => ({ ambient: { ...s.ambient, ...a } })),
  setDirectional: (d) =>
    set((s) => ({ directional: { ...s.directional, ...d } })),
  setSky: (sk) => set((s) => ({ sky: { ...s.sky, ...sk } })),
  setWled: (w) => set((s) => ({ wled: { ...s.wled, ...w } })),
  setLightning: (l) => set((s) => ({ lightning: { ...s.lightning, ...l } })),
  setDayCycle: (patch) =>
    set((s) => ({ dayCycle: { ...s.dayCycle, ...patch } })),
  updateDayPeriod: (id, patch) =>
    set((s) => ({
      dayCycle: {
        ...s.dayCycle,
        periods: s.dayCycle.periods.map((p) =>
          p.id === id ? { ...p, ...patch } : p,
        ),
      },
    })),
  setActivePeriod: (id) =>
    set((s) => {
      const target = s.dayCycle.periods.find((p) => p.id === id);
      if (!target) return {};
      // Snap the clock to the period's start so the loop begins there.
      return {
        dayCycle: { ...s.dayCycle, activePeriodId: id },
        sky: { ...s.sky, timeHours: target.startHour },
      };
    }),
  advancePeriod: () =>
    set((s) => {
      const idx = s.dayCycle.periods.findIndex(
        (p) => p.id === s.dayCycle.activePeriodId,
      );
      const next = s.dayCycle.periods[(idx + 1) % s.dayCycle.periods.length];
      if (!next) return {};
      return {
        dayCycle: { ...s.dayCycle, activePeriodId: next.id },
        sky: { ...s.sky, timeHours: next.startHour },
      };
    }),
  previousPeriod: () =>
    set((s) => {
      const n = s.dayCycle.periods.length;
      const idx = s.dayCycle.periods.findIndex(
        (p) => p.id === s.dayCycle.activePeriodId,
      );
      const prev = s.dayCycle.periods[(idx - 1 + n) % n];
      if (!prev) return {};
      return {
        dayCycle: { ...s.dayCycle, activePeriodId: prev.id },
        sky: { ...s.sky, timeHours: prev.startHour },
      };
    }),
  setLedDisplayMode: (mode) => set({ ledDisplayMode: mode }),
  setLedStreamPipeline: (patch) =>
    set((s) => ({
      ledStreamPipeline: { ...s.ledStreamPipeline, ...patch },
    })),
  setLedLocator: (patch) =>
    set((s) => ({ ledLocator: { ...s.ledLocator, ...patch } })),
  toggleLocatedLed: (index) =>
    set((s) => {
      const i = Math.max(0, Math.floor(index));
      const exists = s.ledLocator.highlighted.includes(i);
      return {
        ledLocator: {
          ...s.ledLocator,
          highlighted: exists
            ? s.ledLocator.highlighted.filter((x) => x !== i)
            : [...s.ledLocator.highlighted, i],
        },
      };
    }),
  clearLocatedLeds: () =>
    set((s) => ({ ledLocator: { ...s.ledLocator, highlighted: [] } })),
  setMapping: (m) => set((s) => ({ mapping: { ...s.mapping, ...m } })),
  setLedLayout: (patch) =>
    set((s) => {
      const layout = patch.layout ?? s.mapping.layout;
      const layoutPitch = patch.layoutPitch ?? s.mapping.layoutPitch;
      const archPlacements = patch.archPlacements ?? s.mapping.archPlacements;
      if (layout !== DUAL_32X8_SLOTTED) {
        return { mapping: { ...s.mapping, layout, layoutPitch, archPlacements } };
      }
      const previous = s.mapping.leds;
      return {
        mapping: {
          ...s.mapping,
          layout,
          layoutPitch,
          archPlacements,
          leds: buildDual32x8Slotted(layoutPitch, archPlacements).map((led, i) => ({
            ...led,
            offset: previous[i]?.offset ?? 0,
          })),
        },
      };
    }),
  setMesh: (m) => set((s) => ({ mesh: { ...s.mesh, ...m } })),
  setUi: (u) => set((s) => ({ ui: { ...s.ui, ...u } })),
  addMappedLed: (dir, pos, normal) =>
    set((s) => {
      if (s.mapping.layout !== "manual") return {};
      return {
        mapping: {
          ...s.mapping,
          leds: [...s.mapping.leds, { dir, pos, normal, offset: 0 }],
        },
      };
    }),
  moveMappedLed: (index, dir, pos, normal) =>
    set((s) => {
      if (s.mapping.layout !== "manual") return {};
      return {
        mapping: {
          ...s.mapping,
          leds: s.mapping.leds.map((l, i) =>
            i === index ? { ...l, dir, pos, normal } : l,
          ),
        },
      };
    }),
  updateMappedLed: (index, patch) =>
    set((s) => ({
      mapping: {
        ...s.mapping,
        leds: s.mapping.leds.map((l, i) =>
          i === index ? { ...l, ...patch } : l,
        ),
      },
    })),
  removeLastMappedLed: () =>
    set((s) => {
      if (s.mapping.layout !== "manual") return {};
      return { mapping: { ...s.mapping, leds: s.mapping.leds.slice(0, -1) } };
    }),
  clearMappedLeds: () =>
    set((s) => {
      if (s.mapping.layout !== "manual") return {};
      return { mapping: { ...s.mapping, leds: [] } };
    }),
  addMappingGaussian: (g) =>
    set((s) => {
      const id =
        g.id && typeof g.id === "string"
          ? g.id
          : `gaussian-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
      const next: MappingGaussian = {
        id,
        pos: g.pos,
        normal: g.normal,
        amplitude: Math.max(0, Math.min(0.5, g.amplitude)),
        width: Math.max(0.005, Math.min(0.5, g.width)),
        height: Math.max(0.005, Math.min(0.5, g.height)),
        rotationDeg: ((g.rotationDeg % 360) + 360) % 360,
      };
      return {
        mapping: {
          ...s.mapping,
          gaussians: [...(s.mapping.gaussians ?? []), next],
        },
      };
    }),
  updateMappingGaussian: (id, patch) =>
    set((s) => ({
      mapping: {
        ...s.mapping,
        gaussians: (s.mapping.gaussians ?? []).map((g) => {
          if (g.id !== id) return g;
          const next = { ...g, ...patch, id: g.id };
          if (typeof next.amplitude === "number") {
            next.amplitude = Math.max(0, Math.min(0.5, next.amplitude));
          }
          if (typeof next.width === "number") {
            next.width = Math.max(0.005, Math.min(0.5, next.width));
          }
          if (typeof next.height === "number") {
            next.height = Math.max(0.005, Math.min(0.5, next.height));
          }
          if (typeof next.rotationDeg === "number") {
            next.rotationDeg = ((next.rotationDeg % 360) + 360) % 360;
          }
          return next;
        }),
      },
    })),
  removeMappingGaussian: (id) =>
    set((s) => ({
      mapping: {
        ...s.mapping,
        gaussians: (s.mapping.gaussians ?? []).filter((g) => g.id !== id),
      },
    })),
  clearMappingBumps: () =>
    set((s) => ({
      mapping: {
        ...s.mapping,
        gaussians: [],
        leds: s.mapping.leds.map((l) => ({ ...l, offset: 0 })),
      },
    })),
}));

/**
 * Apply a previously-saved snapshot to the live store. Returns the values
 * we wrote so the leva controls (which keep their own state) can be
 * imperatively synced.
 */
export function applySnapshot(snap: Snapshot): Snapshot {
  const s = useSimStore.getState();
  s.setEllipsoid(snap.ellipsoid);
  s.setCloud(snap.cloud);
  s.setStrand({
    ...snap.strand,
    colorProfile: resolveLedColorProfile(snap.strand?.colorProfile),
  });
  s.setAmbient(snap.ambient);
  s.setDirectional(snap.directional);
  const snapSky = (snap.sky ?? {}) as Partial<SkyParams> & {
    stops?: LegacyTriStop[];
    palette?: Record<string, unknown>;
  };
  const channels = resolveChannelStops(snapSky);
  s.setSky({
    ...DEFAULTS.sky,
    ...snapSky,
    ...channels,
  });
  // Same caveat as initialState — never re-enable streaming via a load.
  s.setWled({ ...snap.wled, enabled: false });
  s.setLightning(resolveLightning(snap.lightning));
  s.setDayCycle(resolveDayCycle(snap.dayCycle));
  if (snap.ledDisplayMode === "leds" || snap.ledDisplayMode === "sensors") {
    s.setLedDisplayMode(snap.ledDisplayMode);
  } else {
    s.setLedDisplayMode(DEFAULTS.ledDisplayMode);
  }
  s.setLedStreamPipeline({
    ...DEFAULTS.ledStreamPipeline,
    ...snap.ledStreamPipeline,
  });
  s.setLedLocator({ ...DEFAULTS.ledLocator, ...snap.ledLocator });
  s.setMapping(resolveMapping(snap.mapping));
  s.setMesh({ ...DEFAULTS.mesh, ...(snap.mesh ?? {}) });
  s.setCloudTop({ ...DEFAULTS.cloudTop, ...(snap.cloudTop ?? {}) });
  s.setUi({ ...DEFAULTS.ui, ...(snap.ui ?? {}) });
  return snap;
}

/** Snapshot of the persisted slice of the store. */
export function currentSnapshot(): Omit<Snapshot, "version"> {
  const s = useSimStore.getState();
  const {
    stops: _legacyStops,
    palette: _legacyPalette,
    ...sky
  } = s.sky as SkyParams & {
    stops?: LegacyTriStop[];
    palette?: Record<string, unknown>;
  };
  return {
    ellipsoid: s.ellipsoid,
    cloud: s.cloud,
    cloudTop: s.cloudTop,
    strand: s.strand,
    ambient: s.ambient,
    directional: s.directional,
    sky,
    wled: s.wled,
    lightning: s.lightning,
    dayCycle: s.dayCycle,
    ledDisplayMode: s.ledDisplayMode,
    ledStreamPipeline: s.ledStreamPipeline,
    ledLocator: s.ledLocator,
    mapping: s.mapping,
    mesh: s.mesh,
    ui: s.ui,
  };
}

/**
 * Distance-based intensity multiplier for the directional light.
 *
 * A true three.js directional light is parallel rays from infinity, so
 * its `position` only controls the direction — moving it closer or
 * farther has no effect on brightness. We instead apply a softened
 * inverse-square falloff based on the light's distance to the origin so
 * the panel's `distance` slider does something visible.
 *
 *   atten(d) = REF² / (REF² + d²)        with REF = 5
 *
 * At the default light position (≈ 5.4 from origin) this is ≈ 0.46, so
 * sliding the distance lower brightens up to ≈ 1.0, and sliding higher
 * dims toward 0. Both the custom LED shading and the three.js light
 * that shades the (translucent) ellipsoid mesh use this same multiplier
 * so the two views stay consistent.
 */
const DIR_FALLOFF_REF_SQ = 25;
export function directionalDistanceFalloff(distance: number): number {
  return DIR_FALLOFF_REF_SQ / (DIR_FALLOFF_REF_SQ + distance * distance);
}
