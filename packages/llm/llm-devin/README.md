# @deepseek-ai/dsh-llm-devin

Devin (Cognition / Windsurf) adapter for the harness LLM seam. The plugin
mounts a `devin` provider route that streams from Cognition's **cloud-direct**
API (`server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage`)
with no local language server in the path, and a browser-OAuth **sign-in
flow** that authenticates a Devin/Cognition/Windsurf account and stores the
long-lived `devin-session-token$…` API key in the harness credential store.

The transport is a faithful port of the MIT-licensed
[`pi-devin-auth`](https://pi.dev/packages/pi-devin-auth?type=extension&page=18)
extension from the [oh-my-pi](https://github.com/can1357/oh-my-pi) ecosystem,
which itself derives its cloud-direct layer from
[opencode-windsurf-auth](https://github.com/rsvedant/opencode-windsurf-auth).

## Sign in

Once the plugin is mounted in a composition that also mounts the
authorization and credentials services, the Models page offers **Devin
(Cognition / Windsurf)** under its authorization flows:

1. The flow opens `https://windsurf.com/windsurf/signin` in the browser.
2. After signing in, the page displays a token — paste it into the prompt.
3. The flow exchanges it for a long-lived Devin API key via
   `register.windsurf.com` (`SeatManagementService/RegisterUser`) and stores
   it as a `grant` credential record under the `llm-devin` scope.

A key can alternatively be supplied as a plain credential reference (the web
Models page writes it, or export `DEVIN_API_KEY` in the launching
environment). Resolution order per request: the configured `apiKeyEnv`
reference first, then the stored sign-in grant, then `MISSING_CREDENTIAL`.

## Config

Credentials and the model catalog are configured under the `llm-devin:`
settings section (or the `cordis.yml` entry, which doubles as the section's
composition `base`). `apiKeyEnv` is a credential *reference* resolved per
request, so no secret enters this file.

```yaml
- id: llm-devin
  name: '@deepseek-ai/dsh-llm-devin'
  config:
    apiKeyEnv: DEVIN_API_KEY        # credential reference (default)
    baseURL: https://server.codeium.com  # API server override
    models:                          # fallback catalog when the live catalog is unavailable (default: 11 families)
      - id: swe-1-7
        name: SWE-1.7
        contextWindow: 256000
        maxTokens: 128000
    defaultContextWindow: 256000
    maxTokens: 128000               # deployment-chosen default output cap
    retryPolicy:
      mode: normal
      maxRetries: 3
```

## Streaming

Each model call:

- mints a short-lived `user_jwt` (~24-minute TTL, cached and refreshed before
  expiry) via `exa.auth_pb.AuthService/GetUserJwt`;
- consults the per-account catalog (`GetCascadeModelConfigs`) as a best-effort
  pre-flight so tier-disabled models fail with a named error instead of
  Cognition's opaque `permission_denied: "an internal error occurred"`; the
  same cached catalog drives the model selector, so the picker lists only
  UIDs the account can actually use;
- streams `GetChatMessage` over the Connect gRPC envelope and translates
  deltas into harness `StreamChunk`s: text, reasoning, tool-call blocks with
  raw-JSON arguments, then one `usage` chunk before the terminal `finish`.

Session and cascade IDs are reused per `(apiKey, host)` so server-side prompt
caching hits across turns of the same conversation.

## Model Experience

### Provider request

The harness `system` prompt is prepended as a system message; the cloud-direct
layer inlines it into the next user turn (Cognition rejects a raw
`role=system`). Tool schemas are encoded with descriptions truncated to 6,998
characters, the exact limit Cognition's tool validator accepts. The adapter
declares text-only modalities; image input is deferred until attachment
resolution is wired in (the harness projects images to text for such models).

### Provider response

Reasoning deltas render as `reasoning` blocks; tool calls stream as
`tool-call` blocks with `argumentsDelta` fragments; token usage (input,
output, cached-input, reasoning) is emitted before `finish`. A terminal
`stop` with no content maps to `EMPTY_RESPONSE`-style handling; cloud trailer
errors map to stable harness codes (`AUTH`, `QUOTA_EXCEEDED`, `RATE_LIMIT`,
`TRANSPORT`, …). Replay state is not stored: the cloud-direct API has no
per-response replay metadata the adapter needs.

## Known limitations

- **Curated families from the live account catalog** — the selector surfaces
  the cloud-served families (`swe-1-7`, `claude-*`, `glm-5-2`, `kimi-k2-7`,
  `grok-4-5`) from the live `GetCascadeModelConfigs` response, so other models
  the account serves (Gemini, o3, DeepSeek, …) are omitted. Before the first
  fetch resolves — or when no credential is stored or the catalog is
  unreachable — the selector shows the static fallback list.
- **The desktop-app-only GPT-5.6 families are never offered** — the account
  catalog advertises them (its provider-family field is 2, the OpenAI family),
  but the cloud-direct chat endpoint refuses every one with `This model is only
  in Devin Local.`: they run only in the Devin/Windsurf desktop app. Surfacing
  them would advertise models that every request rejects, so
  `WANTED_PREFIXES` and `FALLBACK_MODELS` omit them. A refusal of that shape is
  reported as `INVALID_REQUEST` naming the desktop-app restriction rather than
  as `AUTH`.
- **Images deferred** — models declare `text` input only; attachment
  resolution for the cloud-direct `ImageData` wire field is future work.
- **The sign-in flow lives in the process that started it** — an
  authorization attempt is not durable across a host restart mid-login.
- **One tenant** — the flow targets the single `windsurf.com` region; EU /
  FedStart portal variants are not parameterized yet.
