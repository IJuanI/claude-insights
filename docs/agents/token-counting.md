# Token Counting

## Formula

Canonical implementation: `src/tokenCalc.ts` → `computeTokenTotals(input, output, cacheRead, cacheCreate)`

- **total** = input + output + cacheRead + cacheCreate (all tokens processed)
- **billed** = input + output + cacheCreate + round(cacheRead * 0.1)

`input_tokens` from the API is only the non-cached portion. Cache fields are additive, not subsets.

## Streaming dedup

The Anthropic API writes multiple JSONL entries per request during streaming. Intermediate chunks have `"stop_reason": null`; the final chunk has a string (`"end_turn"`, `"tool_use"`). All chunks repeat the same input/cache tokens — only `output_tokens` differs (cumulative).

**Rule**: only count entries where `stop_reason` is a non-null string.

Implemented in 3 places:
- `src/sessionUsage.ts` — checks `msg['stop_reason']` before accumulating
- `src/agentParser.ts` task parser — same check
- `src/agentParser.ts` `scanUsageInBuffer()` — checks for `"stop_reason":null` string in pre-context

## Where token counts are displayed

| Location | Source | Notes |
|----------|--------|-------|
| Usage dashboard session breakdown | `sessionUsage.ts` → `webview.ts` | Per-window (5h, week, 15d) slicing |
| Agent tab per-task | `agentParser.ts` task accumulator | Server-side |
| Agent tab diagnostics footer | `agentWebviewClient/index.ts` | Client-side, sums `conversationData[].tokenUsage` |
| Agent tab per-agent token line | `agentWebviewClient/index.ts` | Client-side, from task's `tokenUsage` |
| Conversation message footer | `agentParser.ts` conversation parser | Attached to final chunks only (`stop_reason` check) |
| Session tree | `agentParser.ts` `getSessionTokenUsage()` | Regex-scanned, deduped |
