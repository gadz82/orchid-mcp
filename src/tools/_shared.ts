/**
 * Backward-compatible re-export hub for tool-handler helpers.
 *
 * Originally a 305-line bag of context builders, result shapers, and
 * the runWithTooling middleware. Each concept now lives in its own
 * file:
 *
 *   - :mod:`./context` — ``ToolHandlerExtra``, ``ProgressNotification``,
 *                       ``buildRequestContext``, ``buildCallOptions``,
 *                       ``emitProgressNotification``.
 *   - :mod:`./results` — ``isErrorResult``, ``errorToResult``,
 *                       ``isInterrupt``, ``interruptResult``,
 *                       ``chatResult``, ``AuthorizeLink``,
 *                       ``fetchAuthorizeLinks``.
 *   - :mod:`./tooling` — ``runWithTooling``.
 *
 * The single import path ``./_shared.js`` is preserved so every tool
 * handler keeps working.
 */

export {
    buildCallOptions,
    buildRequestContext,
    emitProgressNotification,
    type ProgressNotification,
    type ToolHandlerExtra,
} from "./context.js";

export {
    type AuthorizeLink,
    chatResult,
    errorToResult,
    fetchAuthorizeLinks,
    interruptResult,
    isErrorResult,
    isInterrupt,
} from "./results.js";

export { runWithTooling } from "./tooling.js";
