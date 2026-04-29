/**
 * Session map contract.
 *
 * Binds ``(mcpSessionId, subject) → chatId`` so the host LLM never has to
 * remember an Orchid chat id across turns. Also tracks the "most recent
 * pending HITL interrupt" so :tool:`orchid_resume_chat` knows which chat
 * to post to.
 */

export interface SessionMap {
    getChatId(mcpSessionId: string, subject: string): Promise<string | null>;
    setChatId(mcpSessionId: string, subject: string, chatId: string): Promise<void>;
    clear(mcpSessionId: string, subject: string): Promise<void>;

    setPendingInterrupt(mcpSessionId: string, subject: string, chatId: string): Promise<void>;
    popPendingInterrupt(mcpSessionId: string, subject: string): Promise<string | null>;
}
