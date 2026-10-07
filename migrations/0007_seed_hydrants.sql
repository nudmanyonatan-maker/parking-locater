-- Hydrants on the seeded W 181st St lane (north curb, Audubon -> Amsterdam).
-- Source: NYC DEP hydrant locations (NYC Open Data 5bgh-vtsn), projected onto
-- the W 181st St centerline (NYC Centerline inkn-q76z): H106650 is 16.7 m and
-- H106652 is 43.1 m east of the Audubon Ave centerline. The lane starts at the
-- east crosswalk of Audubon, ~12 m east of that centerline; a hydrant-sized
-- post at the curb ~5 m into the lane in the camera image agrees. So the lane
-- has hydrants at ~5.0 m and ~31.4 m. Only applied while the lane is still the
-- seeded one (a recalibrated lane is left alone).
UPDATE camera_calibrations
SET regions_json = '[{"id":"lane-181-south","kind":"parking","label":"North curb lane (left in view)","streetLabel":"W 181st St, Audubon → Amsterdam","capacity":8,"points":[[0.128,1],[0.307,1],[0.432,0.533],[0.386,0.533]],"hydrantsM":[5,31.4]},{"id":"roadway-181","kind":"roadway","label":"Travel + bus lanes","points":[[0.307,1],[0.9,1],[0.52,0.533],[0.432,0.533]]}]',
    updated_at = '2026-10-07T14:00:00.000Z'
WHERE camera_id = '1ccb8d7c-43d4-450e-b40c-79527766db75'
  AND regions_json = '[{"id":"lane-181-south","kind":"parking","label":"North curb lane (left in view)","streetLabel":"W 181st St, Audubon → Amsterdam","capacity":8,"points":[[0.128,1],[0.307,1],[0.432,0.533],[0.386,0.533]]},{"id":"roadway-181","kind":"roadway","label":"Travel + bus lanes","points":[[0.307,1],[0.9,1],[0.52,0.533],[0.432,0.533]]}]';
