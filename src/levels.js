// Game levels: tilt the phone to get the water into the cup.
// Geometry is in tank-interior coords [0,1] (x right, y down, portrait).
// `a` is the interior aspect (width / height, ≈ 0.46 on a phone): walls are
// T wide in x and T·a tall in y, so every wall is the same number of sim cells
// thick both ways — more than a particle travels in one substep.
//
// Each level: water (start rects), solids (obstacle rects), goal (the cup's
// inside), target (fraction of the water that must sit in the cup), par
// (seconds for three stars), and fill: 'bottom' | 'top' (which way the cup
// fills — 'top' for a cup hanging from the ceiling).

const T = 0.09;

export function buildLevels(a) {
  const ty = T * a;
  return [
    {
      name: 'Tip it',
      hint: 'Tilt right to pour over the wall',
      water: [[0, 0.62, 0.46, 1]],
      solids: [[0.46, 0.52, 0.46 + T, 1]],
      goal: [0.46 + T, 0.3, 1, 1],
      target: 0.35, par: 6, fill: 'bottom',
    },
    {
      name: 'Off the shelf',
      hint: 'Tip it over the lip, then keep it in',
      water: [[0, 0.22, 0.53, 0.4]],
      solids: [[0, 0.4, 0.62, 0.4 + ty], [0.62 - T, 0.14, 0.62, 0.4], [0.55, 0.8, 0.55 + T, 1]],
      goal: [0.55 + T, 0.62, 1, 1],
      target: 0.4, par: 8, fill: 'bottom',
    },
    {
      name: 'Funnel',
      hint: 'Steer the stream into the cup on the left',
      water: [[0, 0.08, 1, 0.28]],
      solids: [
        [0, 0.42, 0.3, 0.42 + ty], [0.18, 0.42 + ty, 0.4, 0.42 + 2 * ty],
        [0.7, 0.42, 1, 0.42 + ty], [0.6, 0.42 + ty, 0.82, 0.42 + 2 * ty],
        [0.3, 0.78, 0.3 + T, 1],
      ],
      goal: [0, 0.6, 0.3, 1],
      target: 0.32, par: 10, fill: 'bottom',
    },
    {
      name: 'Zigzag',
      hint: 'Right, left, right',
      water: [[0, 0.06, 0.45, 0.24]],
      solids: [[0, 0.3, 0.7, 0.3 + ty], [0.3, 0.56, 1, 0.56 + ty], [0.5, 0.82, 0.5 + T, 1]],
      goal: [0.5 + T, 0.7, 1, 1],
      target: 0.45, par: 12, fill: 'bottom',
    },
    {
      name: 'Upside down',
      hint: 'The cup hangs from the ceiling. Turn the phone over.',
      water: [[0, 0.66, 1, 1]],
      solids: [[0.28, 0, 0.28 + T, 0.3], [0.72 - T, 0, 0.72, 0.3]],
      goal: [0.28 + T, 0, 0.72 - T, 0.3],
      target: 0.22, par: 10, fill: 'top',
    },
  ];
}

// Height of the "fill to here" marker inside the cup, from the water's area
// (same particle density in the cup as at the start).
export function markerFor(level) {
  let area = 0;
  for (const w of level.water) area += (w[2] - w[0]) * (w[3] - w[1]);
  const g = level.goal, width = g[2] - g[0];
  const depth = (level.target * area) / width;
  const v = level.fill === 'top' ? g[1] + depth : g[3] - depth;
  return [g[0], Math.min(Math.max(v, g[1]), g[3]), g[2]];
}
