# transapi-forwarder

`transapi-forwarder` is a standalone forwarding layer that lets one YAML model registry expose multiple client-facing API surfaces while each model keeps its own upstream native format.

The package detects incoming Claude, OpenAI Chat Completions, OpenAI file inputs, OpenAI Embeddings, Codex Responses, Gemini API, and Gemini CLI requests, rewrites them into the configured upstream format, forwards the request, and converts the response back into the caller's format.

## What it does

- Loads model routing rules from YAML
- Maps one exposed model name to one upstream model name and base URL
- Converts between `claude`, `openai`, `response`, `gemini`, and `gemini-cli`
- Converts representable file inputs between OpenAI chat `type: "file"`, Responses `input_file`, Claude `document`, and Gemini `inlineData` / `fileData`
- Supports OpenAI `POST /v1/embeddings` and Gemini `:embedContent` / `:batchEmbedContents`
- Passes downstream API keys through to the upstream service
- Preserves same-format streaming passthrough
- Falls back to buffered synthetic SSE when cross-format streaming is requested

## YAML config

```yaml
models:
  - name: claude-via-openai
    aliases: [claude-sonnet-4]
    upstream:
      model: claude-sonnet-4-20250514
      baseUrl: https://api.anthropic.com
      format: claude
      apiKey:
        mode: pass-through
      headers:
        anthropic-version: "2023-06-01"

  - name: gpt-via-codex
    upstream:
      model: gpt-5.1-codex
      baseUrl: https://api.openai.com
      format: response
      apiKey:
        mode: pass-through

  - name: macaron-gpt54-files
    upstream:
      model: gpt-5.4
      baseUrl: https://cc.macaron.xin/openai/v1
      format: openai
      preferResponsesForFiles: true
      apiKey:
        mode: pass-through
```

## Usage

```ts
import { createUniversalForwarder, loadForwarderConfigFromFile } from "transapi-forwarder";

const config = await loadForwarderConfigFromFile("./models.yaml");
const forwarder = createUniversalForwarder({ config });

export async function fetch(request: Request): Promise<Response> {
  return forwarder.handle(request);
}
```

## CLI

The package also ships a small server CLI so you can boot a local forwarder without writing any wrapper code.

From the repo during development:

```bash
bun run serve -- --config ./models.yaml --port 8787
```

After building or installing the package:

```bash
transapi-forwarder --config ./models.yaml --host 127.0.0.1 --port 8787
```

For quick one-model local testing, you can skip YAML entirely and hydrate the upstream from provider env vars:

```bash
export OPENAI_BASE_URL="https://cc.macaron.xin/openai/v1"
export OPENAI_API_KEY="..."

transapi-forwarder \
  --model gpt-5.4 \
  --from-openai-env \
  --prefer-responses-for-files \
  --port 8787
```

That quick-start mode also supports explicit flags such as `--upstream-format`, `--upstream-base-url`, `--upstream-model`, `--api-key`, `--api-key-header`, `--header name=value`, and `--alias`.

The bundled CLI also uses a keep-alive upstream fetcher so repeated requests to the same provider can reuse TCP/TLS connections instead of reconnecting every time.

## Supported client endpoints

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `POST /v1/chat/completions`
- `POST /v1/embeddings`
- `POST /v1/responses`
- `POST /v1/responses/compact`
- `POST /v1beta/models/:model:generateContent`
- `POST /v1beta/models/:model:streamGenerateContent`
- `POST /v1beta/models/:model:embedContent`
- `POST /v1beta/models/:model:batchEmbedContents`
- `POST /v1internal/models/:model:generateContent`
- `POST /v1internal/models/:model:streamGenerateContent`
- `GET /v1/models`

## Notes

- Same-format streaming is forwarded directly.
- Same-format non-stream requests are also forwarded directly so vendor-specific fields survive round-trip unchanged.
- Same-format OpenAI/OpenRouter chat passthrough preserves vendor file extensions such as `plugins` and assistant `annotations` without canonicalizing them.
- `upstream.preferResponsesForFiles: true` lets an OpenAI-compatible upstream switch file-bearing chat requests onto `/v1/responses`, which is useful for gateways such as `cc.macaron.xin/openai/v1` where file inputs work more reliably on the Responses surface than on `/chat/completions`.
- When that file-routing preference is active for a non-stream caller, the forwarder can request `stream: true` upstream and buffer the SSE back into a normal JSON response, which works around gateways that return an empty JSON string for non-stream file Responses.
- When a downstream `POST /v1/responses` body uses Responses-native context state such as `context_management`, `previous_response_id`, or opaque compacted items in `input`, an OpenAI-compatible upstream is automatically switched onto its native `/v1/responses` endpoint so those items are preserved instead of being flattened into chat completions.
- Cross-format file conversion currently stays conservative: PDF URLs/base64 payloads and Gemini file parts are converted between representable formats; provider-native file IDs only survive on OpenAI/Responses-family routes.
- Cross-format file rendering fills in a safe filename such as `document.pdf` when the source protocol carries file bytes plus MIME type but no filename, because some Responses-compatible gateways reject filename-less `input_file` parts.
- Embeddings are handled on a separate compatibility path from chat/responses so request conversion does not interfere with message, tool, or compaction semantics.
- Compaction is handled conservatively as its own Responses-native protocol surface: `POST /v1/responses/compact` is forwarded directly to Responses/OpenAI-compatible upstreams, opaque compact output items are preserved without inventing Claude/OpenAI-chat/Gemini equivalents, and chat/messages/generateContent-style request bodies can be minimally converted into Responses compact input while the compact response still stays in native Responses format.
- Claude server-side compaction on `POST /v1/messages` is also mapped onto the shared compact state path: Claude `context_management.edits[].type = "compact_20260112"` is converted to Responses `context_management`, Claude `compaction` blocks are carried across the boundary as opaque Responses compaction items, and the forwarder auto-adds the Claude beta header `compact-2026-01-12` when the upstream Claude request needs compaction support.
- Claude compaction accounting now keeps more of Anthropic's shape intact across the bridge: compaction-aware `count_tokens` requests preserve `context_management` on the Claude side, and Claude `usage.iterations` is surfaced on downstream Responses `usage.iterations` so callers can recover billed compaction iterations instead of seeing only the final message-token totals.
- The forwarder now applies a lightweight rectifier layer inspired by Claude Code Hub: `/v1/responses` and `/v1/responses/compact` `input` payloads are normalized before routing, Claude billing-header system blocks are stripped before forwarding, and Claude-upstream 400s for low thinking budgets or invalid thinking signatures trigger one in-place repair retry on the same upstream request body.
- That Claude/Responses compaction bridge is intentionally opaque-first: the forwarder preserves continuity across turns, but Claude-only options without a clear Responses equivalent currently degrade best-effort rather than claiming strict semantic parity.
- Unlike Claude Code Hub, `transapi-forwarder` does not currently persist rectifier audit records such as `specialSettings`; the behavior is compatibility-focused and intentionally stateless.
- Cross-format embeddings conversion currently stays conservative: text embeddings are converted between OpenAI and Gemini, while Gemini multimodal inputs and OpenAI token-array inputs are only passed through to same-format upstreams.
- Cross-format streaming is currently synthesized from a buffered upstream response, so the protocol shape matches the caller but token-by-token live streaming is not preserved yet.
- When multiple downstream credentials are present, they must match; conflicting `Authorization` / `x-api-key` / `x-goog-api-key` / `?key=` values are rejected with `401`.
- Versioned upstream bases such as `/openai/v1` and `/gemini/v1beta` are handled without duplicating the version prefix.
- Some Response API gateways return a JSON string that contains SSE events even when `stream: false`; the package normalizes that variant too.
- The bundled YAML loader intentionally supports a focused subset: nested objects, arrays, quoted strings, booleans, numbers, and inline arrays.
