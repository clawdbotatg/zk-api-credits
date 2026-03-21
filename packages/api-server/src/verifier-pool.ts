/**
 * verifier-pool.ts
 *
 * Worker thread pool for UltraHonk proof verification.
 * Each worker owns a hot WASM backend — no per-request init cost.
 * Overflow requests queue up and drain as workers free up.
 */

import { Worker } from "worker_threads";
import { fileURLToPath } from "url";
import path from "path";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface PendingRequest {
  id: number;
  proofHex: string;
  publicInputs: string[];
  resolve: (valid: boolean) => void;
  reject: (err: Error) => void;
}

interface WorkerState {
  worker: Worker;
  busy: boolean;
  pendingId: number | null;
  pendingResolve: ((valid: boolean) => void) | null;
  pendingReject: ((err: Error) => void) | null;
}

export class VerifierPool {
  private workers: WorkerState[] = [];
  private queue: PendingRequest[] = [];
  private nextId = 1;
  private ready = false;
  private readyCount = 0;

  constructor(
    private bytecode: string,
    private workerScriptPath: string,
    private poolSize: number = Math.max(1, os.cpus().length - 1)
  ) {}

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      let failed = false;
      for (let i = 0; i < this.poolSize; i++) {
        const worker = new Worker(this.workerScriptPath, {
          workerData: { bytecode: this.bytecode },
          // worker runs compiled JS from dist/; point to the compiled worker
        });

        const state: WorkerState = {
          worker,
          busy: false,
          pendingId: null,
          pendingResolve: null,
          pendingReject: null,
        };

        worker.on("message", (msg: any) => {
          if (msg.ready) {
            this.readyCount++;
            if (this.readyCount === this.poolSize) {
              this.ready = true;
              resolve();
            }
            return;
          }
          // Verification result
          state.busy = false;
          const res = state.pendingResolve;
          const rej = state.pendingReject;
          state.pendingId = null;
          state.pendingResolve = null;
          state.pendingReject = null;

          if (msg.error) {
            rej?.(new Error(msg.error));
          } else {
            res?.(msg.valid);
          }
          // Drain queue
          this._drain(state);
        });

        worker.on("error", (err) => {
          if (!failed && !this.ready) {
            failed = true;
            reject(err);
          }
          if (state.pendingReject) {
            state.pendingReject(err);
            state.busy = false;
            state.pendingId = null;
            state.pendingResolve = null;
            state.pendingReject = null;
          }
        });

        this.workers.push(state);
      }
    });
  }

  verify(proofHex: string, publicInputs: string[]): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const req: PendingRequest = { id, proofHex, publicInputs, resolve, reject };
      // Try to dispatch immediately to a free worker
      const free = this.workers.find((w) => !w.busy);
      if (free) {
        this._dispatch(free, req);
      } else {
        this.queue.push(req);
      }
    });
  }

  private _dispatch(state: WorkerState, req: PendingRequest) {
    state.busy = true;
    state.pendingId = req.id;
    state.pendingResolve = req.resolve;
    state.pendingReject = req.reject;
    state.worker.postMessage({
      id: req.id,
      proofHex: req.proofHex,
      publicInputs: req.publicInputs,
    });
  }

  private _drain(state: WorkerState) {
    if (this.queue.length > 0 && !state.busy) {
      const next = this.queue.shift()!;
      this._dispatch(state, next);
    }
  }

  get size() { return this.poolSize; }
  get activeCount() { return this.workers.filter((w) => w.busy).length; }
  get queueDepth() { return this.queue.length; }

  async destroy() {
    await Promise.all(this.workers.map((s) => s.worker.terminate()));
  }
}
