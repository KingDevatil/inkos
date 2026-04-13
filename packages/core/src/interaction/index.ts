// Interaction module exports

export type { InteractionEvent, ExecutionState, ExecutionStatus } from "./events.js";
export type { InteractionRuntimeTools } from "./runtime.js";
export type { BookCreationDraft, InteractionSession, PendingDecision, InteractionMessage } from "./session.js";
export type { AutomationMode } from "./modes.js";
export type { InteractionIntentType } from "./intents.js";
export { appendInteractionMessage, appendInteractionEvent, bindActiveBook, clearPendingDecision, updateCreationDraft, clearCreationDraft, updateAutomationMode } from "./session.js";
export { routeNaturalLanguageIntent } from "./nl-router.js";
export { createProjectSession, loadProjectSession, persistProjectSession, resolveSessionActiveBook } from "./project-session-store.js";
