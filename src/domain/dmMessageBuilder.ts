import type { PersonalNotificationEvent } from "../models/domainTypes.js";

/** Placeholder for richer templates; events ship with text today. */
export function renderDmText(event: PersonalNotificationEvent): string {
  return event.text;
}
