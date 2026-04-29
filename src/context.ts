/**
 * Runtime dependency bag passed to every tool handler.
 *
 * Assembled once in :func:`buildServer`; handlers receive it instead of
 * reaching for module-level globals.
 */

import type { AuthStrategy } from "./auth/base.js";
import type { OrchidAPIClient } from "./http/orchidClient.js";
import type { Logger } from "./observability/logger.js";
import type { RateLimiter } from "./rateLimit.js";
import type { SessionMap } from "./sessions/base.js";
import type { Settings } from "./settings.js";

export interface AppContext {
    settings: Settings;
    logger: Logger;
    httpClient: OrchidAPIClient;
    sessionMap: SessionMap;
    authStrategy: AuthStrategy;
    rateLimiter: RateLimiter;
}
