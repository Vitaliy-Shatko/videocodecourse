/**
 * Main-thread facade over the AI worker. Falls back to running the search on
 * the main thread (deferred with setTimeout) when module workers are
 * unavailable, e.g. when the page is opened via file://.
 */
import { searchFen } from './ai.js';

export class AiClient {
  constructor() {
    this._worker = null;
    this._nextId = 1;
    this._pending = new Map();
    this._createWorker();
  }

  _createWorker() {
    if (typeof Worker === 'undefined') return;
    try {
      this._worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
      this._worker.onmessage = (event) => this._onMessage(event.data);
      this._worker.onerror = (event) => {
        // A broken worker (e.g. file:// origin) means every pending request would hang.
        for (const [id, pending] of this._pending) {
          this._pending.delete(id);
          pending.fallback();
        }
        this._worker.terminate();
        this._worker = null;
        if (event && event.preventDefault) event.preventDefault();
      };
    } catch {
      this._worker = null;
    }
  }

  _onMessage(data) {
    const pending = this._pending.get(data.id);
    if (!pending) return;
    if (data.type === 'progress') {
      pending.onProgress?.(data);
    } else if (data.type === 'result') {
      this._pending.delete(data.id);
      pending.resolve(data.result);
    } else if (data.type === 'error') {
      this._pending.delete(data.id);
      pending.reject(new Error(data.message));
    }
  }

  /**
   * @param {string} fen
   * @param {object} options search options (see ai.js findBestMove)
   * @param {function} [onProgress]
   * @returns {Promise<{move, score, depth, nodes, timeMs}|null>}
   */
  search(fen, options, onProgress) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const runInline = () => {
        setTimeout(() => {
          try {
            resolve(searchFen(fen, { ...options, onProgress }));
          } catch (error) {
            reject(error);
          }
        }, 20);
      };
      if (!this._worker) {
        runInline();
        return;
      }
      this._pending.set(id, { resolve, reject, onProgress, fallback: runInline });
      this._worker.postMessage({ id, fen, options });
    });
  }

  /** Cancels all in-flight searches (their promises never settle). */
  cancel() {
    if (this._pending.size === 0) return;
    this._pending.clear();
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
      this._createWorker();
    }
  }
}
