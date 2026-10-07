// API contract shared by the Worker (worker/) and the React app (src/).
// Keep this file dependency-free so both sides can import it.

/** How trustworthy the camera's current frame is. */
export type Freshness = 'live' | 'stale' | 'offline' | 'unknown';

/** Parking verdict for a camera or candidate. Maps to map colors:
 *  likely_available = green, possible = yellow, none = red, unknown = gray. */
export type ParkingStatus = 'likely_available' | 'possible' | 'none' | 'unknown';

export type Usefulness = 'yes' | 'no' | 'unknown';

/**
 * Calibration region kinds. A `parking` region is the curb lane where cars park
 * (rule PARKING_ALLOWED). `restricted` marks hydrants, driveways, bus stops,
 * crosswalks (rule RESTRICTED). `ignore` hides parts of the frame from analysis
 * (rule IGNORE). `roadway` and `sidewalk` are context: vehicles whose footprint
 * is on the roadway are treated as moving / double-parked, not parked.
 */
export type RegionKind = 'parking' | 'restricted' | 'ignore' | 'roadway' | 'sidewalk';
export type CurbRule = 'PARKING_ALLOWED' | 'RESTRICTED' | 'IGNORE';

export const REGION_RULE: Record<RegionKind, CurbRule | null> = {
  parking: 'PARKING_ALLOWED',
  restricted: 'RESTRICTED',
  ignore: 'IGNORE',
  roadway: null,
  sidewalk: null,
};

/** Point in normalized image coordinates: x and y in [0, 1], origin top-left. */
export type Point = [number, number];

export interface Region {
  id: string;
  kind: RegionKind;
  /**
   * Polygon vertices, normalized. For `parking` regions this MUST be exactly 4
   * points in order: [start-curb, start-traffic, end-traffic, end-curb], where
   * "start"/"end" are the two ends of the lane along the street and "curb" is
   * the sidewalk edge. The analyzer maps this quad to a unit rectangle
   * (u along the street, v across) with a homography.
   */
  points: Point[];
  label?: string;
  /** parking only: how many cars fit bumper-to-bumper in this lane (user estimate). */
  capacity?: number;
  /** parking only: human label shown in the app, e.g. "Audubon Ave, east curb, 181st→182nd". */
  streetLabel?: string;
  /** parking only: approximate location of the lane's midpoint, for the map marker. */
  anchor?: { lat: number; lon: number };
  /** parking only: hydrants along the curb, in metres from the lane start (lane length = capacity x 6.1 m). */
  hydrantsM?: number[];
}

export interface Calibration {
  cameraId: string;
  regions: Region[];
  /** Pixel size of the frame the user calibrated on (frames are normally 352x240). */
  referenceWidth: number;
  referenceHeight: number;
  updatedAt: string;
}

export interface HomeLocation {
  address: string;
  lat: number;
  lon: number;
  /** Which geocoder produced the coordinates (or "fallback" if all failed). */
  source: string;
  geocodedAt: string;
}

export interface Camera {
  id: string;
  name: string;
  area: string | null;
  lat: number;
  lon: number;
  /** Online flag from the TMC catalog. */
  catalogOnline: boolean;
  distanceMi: number;
}

export interface CameraPreference {
  usefulness: Usefulness;
  notes: string | null;
  streetLabel: string | null;
  updatedAt: string | null;
}

export interface FrameState {
  lastHash: string | null;
  lastFetchedAt: string | null;
  /** When the frame bytes last changed. Identical consecutive frames => stale. */
  lastChangedAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  freshness: Freshness;
}

/** A detected object in normalized image coordinates. */
export interface DetectedObject {
  label: string;
  score: number;
  box: { xmin: number; ymin: number; xmax: number; ymax: number };
  /** Analyzer's interpretation (only for vehicles). */
  role?: 'parked' | 'roadway' | 'ignored' | 'outside';
}

export interface ParkingCandidate {
  id?: number;
  cameraId: string;
  regionId: string | null;
  streetLabel: string;
  spaces: number;
  confidence: number;
  status: Exclude<ParkingStatus, 'none' | 'unknown'>;
  /** Lane-normalized extent of the gap along the street, 0..1. */
  gapStart: number;
  gapEnd: number;
  /** Estimated open curb length in metres (a car needs ~6 m). */
  lengthM?: number;
  /** Gap outline in normalized image coordinates (for overlays). */
  polygon: Point[];
  /** Approximate location (lane anchor, else camera position). Not an exact spot. */
  lat: number;
  lon: number;
  /** True when lat/lon is just the camera position. */
  approximateLocation: boolean;
  reasons: string[];
}

/** Output of a ParkingDetector run. */
export interface ParkingAnalysis {
  cameraId: string;
  timestamp: string;
  frameFetchedAt: string | null;
  frameHash: string | null;
  freshness: Freshness;
  detector: string;
  vehiclesDetected: number;
  parkedVehicles: number;
  candidateSpaces: number;
  confidence: number;
  status: ParkingStatus;
  /** Machine-readable reason when status is unknown, e.g. "needs_calibration". */
  reason: string | null;
  objects: DetectedObject[];
  candidates: ParkingCandidate[];
  /** Free-form notes for the debug view. */
  notes: string[];
  error: string | null;
}

export interface Detection extends ParkingAnalysis {
  id: number;
}

export interface DetectionHistoryItem {
  id: number;
  timestamp: string;
  status: ParkingStatus;
  candidateSpaces: number;
  confidence: number;
  vehiclesDetected: number;
  freshness: Freshness;
  reason: string | null;
}

export interface CameraSummary extends Camera {
  preference: CameraPreference;
  calibrated: boolean;
  frame: FrameState;
  latest: Detection | null;
  /** Seconds since `latest.timestamp`, computed server-side at response time. */
  latestAgeSeconds: number | null;
}

export interface CameraDetail extends CameraSummary {
  calibration: Calibration | null;
  previous: DetectionHistoryItem | null;
  imageUrl: string;
}

export type SummaryState = 'available' | 'possible' | 'none' | 'unknown';

export interface ParkingCurrentResponse {
  generatedAt: string;
  home: HomeLocation;
  radiusMi: number;
  minConfidence: number;
  summary: {
    state: SummaryState;
    spots: number;
    headline: string;
    /** Newest detection time among watched cameras. */
    updatedAt: string | null;
  };
  /** Fresh candidates only, best first. */
  candidates: ParkingCandidate[];
  /** Cameras marked useful (watched) within the radius. */
  watched: CameraSummary[];
  /** Every camera within the radius (for map markers). */
  nearby: CameraSummary[];
  /** settings.maxDetectionAgeSeconds the response was built with. Optional: clients fall back to the default. */
  maxDetectionAgeSeconds?: number;
}

export type BackgroundMode = 'off' | 'when_alerts_on' | 'always';

/** Server-side settings (stored in D1 application_settings). */
export interface AppSettings {
  home: HomeLocation;
  radiusMi: 0.25 | 0.5 | 0.75;
  minConfidence: number;
  notificationsEnabled: boolean;
  backgroundMode: BackgroundMode;
  /** Minimum seconds between analyses of the same camera (cost control). */
  analysisCooldownSeconds: number;
  /** Results older than this are shown as stale and never count as current parking. */
  maxDetectionAgeSeconds: number;
  /** Optional second opinion from a vision LLM (experimental, costs more). */
  vlmVerify: boolean;
}

export interface HealthResponse {
  ok: boolean;
  time: string;
  version: string;
  checks: Record<string, { ok: boolean; detail?: string }>;
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

export interface PushConfigResponse {
  enabled: boolean;
  publicKey: string | null;
}

/** Where the car is parked (one at a time; KV key "spot"). Times are epoch ms. */
export interface CarSpot {
  lat: number;
  lng: number;
  note: string;
  /** Move the car by this time (street cleaning); Discord pings 5 min before. */
  moveBy: number | null;
  createdAt: number;
  reminderSent: boolean;
  /** Street-cleaning block face the car is on (shared/cleaning.ts), if known. */
  faceId?: string | null;
}
