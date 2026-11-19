/** Browser bundle for the standalone simulated Limbo page (assets/limbo-sim/engine.js). */
import defaults from '../../../config/limbo-sim.json';
export { LimboEngine, cryptoRng, validateSettings } from './limboEngine.ts';
export const DEFAULT_SETTINGS = defaults;
