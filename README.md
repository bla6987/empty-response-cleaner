# Empty Response Cleaner

Cleans empty generated responses and swipes, and can retry transient API failures
within the configured retry count and delay. Existing chat/swipe safety checks
still determine when cleanup and retry are allowed.

## Request inspection

Disabled API retries, disabled extensions, unarmed generations and unrelated
endpoints bypass request parsing and network inspection. Matching foreground
requests are compared against the actual generation prompt, including edits made
by later generation-event listeners. Once matched, the cleaner releases the full
prompt and parsed request body; retry and swipe state retain only the lifecycle
information needed to finish safely.

Finite API responses and HTML error pages are inspected through a clone, up to a
256 KiB byte prefix. Known SSE streams are not read by this inspector. Unknown
stream types are sniffed only long enough to distinguish an HTML page, with the
same hard cap even if the transport delivers a single large chunk. Diagnostic
inspection never consumes the caller's response. A confirmed HTTP 200 HTML error
page is still replaced with the standard API error response while API retry
inspection is enabled. Errors hidden beyond the prefix are left to SillyTavern's
normal response handling.

Runtime Signal Bus is optional. Version 1.1 shares the parsed JSON request with
other observers. Older versions use local parsing; if a v1.0 bus is already inside
another extension's fetch wrapper, the standalone interception path is used to
preserve that wrapper chain.

## Tests

```sh
node --test tests/*.test.cjs
```
