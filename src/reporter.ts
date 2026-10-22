import { BreadcrumbBuffer } from "./breadcrumbs.js";
import { Configuration } from "./configuration.js";
import { DeliveryQueue } from "./deliveryQueue.js";
import { EventBuilder } from "./eventBuilder.js";

/**
 * Ties Configuration, EventBuilder, and DeliveryQueue together into the one thing callers
 * actually need: report an exception. Mirrors sdks/typescript/src/reporter.ts: never throws. An
 * error reporter that itself throws while reporting an error is the worst possible failure mode,
 * so every path here is wrapped to guarantee this never propagates back into the host app.
 */
export class Reporter {
  private configuration: Configuration;
  private eventBuilder: EventBuilder;
  private deliveryQueue: DeliveryQueue;
  private breadcrumbs: BreadcrumbBuffer | null;

  constructor(configuration: Configuration, eventBuilder: EventBuilder, deliveryQueue: DeliveryQueue, breadcrumbs: BreadcrumbBuffer | null = null) {
    this.configuration = configuration;
    this.eventBuilder = eventBuilder;
    this.deliveryQueue = deliveryQueue;
    this.breadcrumbs = breadcrumbs;
  }

  report(error: Error, context: Record<string, unknown> = {}, user?: Record<string, unknown> | null, traceId: string | null = null): void {
    try {
      if (!this.configuration.isEnabled()) {
        return;
      }

      if (this.configuration.strictPrivacy) {
        // No breadcrumbs, message or other free text goes out (see strictPrivacy.ts).
        this.deliveryQueue.push(this.eventBuilder.buildStrict(error, context, user, traceId));
        return;
      }

      const payload = this.eventBuilder.build(error, context, user, this.breadcrumbs?.all() ?? [], traceId);
      this.deliveryQueue.push(payload);
    } catch (e) {
      const err = e as Error;
      this.configuration.log(`[forge-ops-tracker] report failed: ${err.name}: ${err.message}`);
    }
  }
}
