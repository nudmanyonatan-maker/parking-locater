// The car we are parking, and the curb rules we apply. Shared by the analyzer
// (what counts as an open spot) and the app (what it tells you).

export const CAR = {
  name: '2016 Ford Escape',
  short: 'Escape',
  /** 178.1 in bumper to bumper. */
  lengthM: 4.52,
  /** Parallel parking between two cars: car length + ~4 ft to get in. */
  needBetweenCarsM: 5.7,
  /** One end open (hydrant zone, corner): you can swing in using it, so + ~2 ft. */
  needOneOpenEndM: 5.1,
};

/** NYC says 15 ft from a hydrant; we accept 5 ft. */
export const HYDRANT_CLEARANCE_M = 1.524;

export const M_TO_FT = 3.28084;
export const feet = (m: number) => Math.round(m * M_TO_FT);
