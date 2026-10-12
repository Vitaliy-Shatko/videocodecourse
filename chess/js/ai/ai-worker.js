/**
 * Web Worker entry point: keeps the search off the main thread so the board
 * stays responsive while the computer is thinking.
 *
 * Protocol:
 *   in : { id, fen, options: { maxDepth, timeMs, randomness } }
 *   out: { id, type: 'progress', ...info }  (after each completed depth)
 *        { id, type: 'result', result }      (final; result may be null)
 *        { id, type: 'error', message }
 */
import { searchFen } from './ai.js';

self.onmessage = (event) => {
  const { id, fen, options } = event.data;
  try {
    const result = searchFen(fen, {
      ...options,
      onProgress: (info) => self.postMessage({ id, type: 'progress', ...info }),
    });
    self.postMessage({ id, type: 'result', result });
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error && error.message ? error.message : String(error) });
  }
};
