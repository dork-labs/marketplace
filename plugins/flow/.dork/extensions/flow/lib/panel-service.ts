/**
 * The Flow panel's server side (spec `claude-account-ui` §8.5): builds the
 * panel's model, pauses and resumes flow in the projects it shows, and pushes
 * a new model to the panel as the `panel` event, at most once a second, when
 * an account's usage or a project's runs or pause change.
 *
 * @module @dorkos/flow/extension/panel-service
 */

import type { ExecFileLike } from './advisor.ts';
import type { AccountsApi } from './host-types.ts';
import {
  CheckoutResolver,
  buildPanel,
  discoverCheckouts,
  readProjects,
  reportsSchedulesOff,
  runPauseCommand,
  type PanelModel,
} from './panel.ts';

/** The shortest gap between two `panel` events, in ms. */
export const EMIT_INTERVAL_MS = 1_000;

/** The most chat folders remembered as projects to cover. */
const REMEMBERED_CWDS = 50;

/** What the panel service needs from its host and machine. */
export interface PanelServiceDeps {
  /** The DorkOS home. */
  dorkHome: string;
  /** flow's plugin folder. */
  flowRoot: string;
  /** DorkOS's accounts API. */
  accounts: Pick<AccountsApi, 'list' | 'usage'>;
  /** Sends the `panel` event (`ctx.emit`). */
  emit: (event: string, data: unknown) => void;
  /** Runs a command with no shell. */
  execFile: ExecFileLike;
  /** The clock. */
  now: () => Date;
  /** Folder to main checkout (default: flow's `resolveMainCheckout`). */
  resolver?: CheckoutResolver;
  /** Where to log. */
  log: (message: string) => void;
}

/** The Flow panel's model, its writes, and its live event. */
export class PanelService {
  private readonly resolver: CheckoutResolver;
  private readonly cwds: string[] = [];
  private schedulesOff = false;
  private lastSent: string | null = null;
  private lastEmitAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  /**
   * @param deps - The host, machine and clock.
   */
  constructor(private readonly deps: PanelServiceDeps) {
    this.resolver = deps.resolver ?? new CheckoutResolver();
  }

  /**
   * Cover the project of a chat's folder from now on.
   *
   * @param cwd - The folder the panel was opened beside.
   */
  noteCwd(cwd: unknown): void {
    if (typeof cwd !== 'string' || cwd === '' || this.cwds.includes(cwd)) return;
    this.cwds.push(cwd);
    if (this.cwds.length > REMEMBERED_CWDS) this.cwds.shift();
  }

  /** The projects the panel shows now. */
  private projects() {
    return readProjects(discoverCheckouts(this.deps.dorkHome, this.cwds, this.resolver));
  }

  /**
   * Build the model.
   *
   * @returns The `GET /panel` body.
   */
  async model(): Promise<PanelModel> {
    const [summaries, usage] = await Promise.all([
      this.deps.accounts.list(),
      this.deps.accounts.usage(),
    ]);
    return buildPanel({
      dorkHome: this.deps.dorkHome,
      summaries,
      usage,
      projects: this.projects(),
      now: this.deps.now(),
      schedulesOff: this.schedulesOff,
    });
  }

  /**
   * Pause flow in every shown project not paused yet.
   *
   * @returns The new model.
   */
  async pause(): Promise<PanelModel> {
    for (const project of this.projects()) {
      if (project.paused) continue;
      await runPauseCommand({
        ...this.pauseDeps(),
        command: 'pause',
        mainCheckout: project.mainCheckout,
      });
    }
    // A new pause starts a new cycle: an older note about schedules is moot.
    this.schedulesOff = false;
    return this.answer();
  }

  /**
   * Resume flow in every shown project that is paused.
   *
   * @returns The new model.
   */
  async resume(): Promise<PanelModel> {
    for (const project of this.projects()) {
      if (!project.paused) continue;
      const output = await runPauseCommand({
        ...this.pauseDeps(),
        command: 'resume',
        mainCheckout: project.mainCheckout,
      });
      if (reportsSchedulesOff(output)) this.schedulesOff = true;
    }
    return this.answer();
  }

  /** The command runner and flow's folder. */
  private pauseDeps() {
    return { execFile: this.deps.execFile, flowRoot: this.deps.flowRoot };
  }

  /** Build the model after a write, and tell every open panel. */
  private async answer(): Promise<PanelModel> {
    const model = await this.model();
    this.request();
    return model;
  }

  /**
   * Ask for a `panel` event: sent now, or when a second has passed since the
   * last one. Requests in between share one event. An event whose model is the
   * same as the last one sent is not sent.
   */
  request(): void {
    if (this.disposed || this.timer !== null) return;
    const wait = this.lastEmitAt + EMIT_INTERVAL_MS - Date.now();
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.send();
      },
      Math.max(0, wait)
    );
  }

  /** Build the model and send it when it changed. */
  private async send(): Promise<void> {
    if (this.disposed) return;
    let model: PanelModel;
    try {
      model = await this.model();
    } catch (error) {
      this.deps.log(`[flow] could not build the Flow panel: ${String(error)}`);
      return;
    }
    const text = JSON.stringify(model);
    if (text === this.lastSent) return;
    this.lastSent = text;
    this.lastEmitAt = Date.now();
    this.deps.emit('panel', model);
  }

  /** Stop sending events. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
