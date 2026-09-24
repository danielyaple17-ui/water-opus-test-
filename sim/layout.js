// Shared layout of the ping-pong ArrayBuffer between the main thread and the
// sim worker. Both directions transfer the bare buffer (no structured-clone
// objects per frame): the main thread writes the step inputs into the header,
// the worker overwrites the header with its stats and fills the payload.
//
//   [ HEADER floats ][ capacity × (x, y, foam, speed) ][ MAX_BUBBLES × (x, y, r, a) ]

export const HEADER = 32;

// main → worker (step request)
export const I_DT = 0, I_GX = 1, I_GY = 2, I_AX = 3, I_AY = 4, I_SPIN = 5;
// worker → main (frame)
export const S_COUNT = 0, S_BUBBLES = 1, S_SIMTIME = 2, S_STEPMS = 3, S_STEPMSMAX = 4, S_SUBSTEPS = 5,
  S_FLUID = 6, S_FILL = 7, S_OUTSIDE = 8, S_COMX = 9, S_COMY = 10, S_ANGMOM = 11, S_ACTIVITY = 12,
  S_FOAMSUM = 13, S_MAXSPEED = 14, S_POUR = 15, S_STEPS = 16, S_GEN = 17,
  S_GOAL = 18; // particles inside the level's goal rect (game), else 0

export function bufferFloats(capacity, maxBubbles) {
  return HEADER + 4 * (capacity + maxBubbles);
}
