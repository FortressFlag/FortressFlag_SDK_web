/** How much the SDK writes to the console. */
export type LogPolicy =
  /** Errors and one-time configuration warnings only. The default. */
  | "standard"
  /**
   * Adds refresh lifecycle and resolution sources. Never enable in a shipping page: it
   * names the customer's flag keys in the end user's devtools.
   */
  | "verbose"
  /** Nothing at all. */
  | "silent";

/**
 * The SDK's only mouth. Routed through one type so the rules have one enforcement point:
 * flag VALUES, tag VALUES and SDK keys never appear in a console line — keys and
 * mechanically derived facts may. `verbose` names the customer's flag keys and is documented
 * as never-in-a-shipping-page for exactly that reason.
 */
export class Log {
  constructor(
    private readonly policy: LogPolicy,
    private readonly category: string,
  ) {}

  error(message: string): void {
    if (this.policy === "silent") return;
    console.error(`[FortressFlag:${this.category}] ${message}`);
  }

  warning(message: string): void {
    if (this.policy === "silent") return;
    console.warn(`[FortressFlag:${this.category}] ${message}`);
  }

  debug(message: string): void {
    if (this.policy !== "verbose") return;
    console.debug(`[FortressFlag:${this.category}] ${message}`);
  }
}
