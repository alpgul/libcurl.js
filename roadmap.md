# Roadmap

Planned and proposed work for the wisp client (`client/wisp_client`) and the
Cloudflare worker (`server/worker-wisp-server`).

**Ordering lens: performance first**, then resilience/resource protection, then
features and hardening. Items within a tier are ordered by impact for effort.

Tags: `[P]` performance · `[R]` resilience · `[S]` security · `[F]` feature.
Effort: `S` small, `M` medium, `L` large.

Legend:
- [x] done
- [ ] proposed

## Shipping (current state)

- [x] Wisp v2 protocol support in the worker (`INFO` handshake, extension
      negotiation, MOTD, password auth, stream-open confirmation, v1 fallback)
- [x] Wisp v2 support in the client (`wisp_extensions`, auth credentials,
      automatic v1 fallback, `server_motd`, `udp_enabled`)
- [x] Wire compatibility proven between the real client and real server via
      integration tests (`server/worker-wisp-server/test/integration.test.js`)
- [x] Full-duplex data flow verified (concurrent, interleaved bidirectional
      relay)
- [x] Password-auth payload follows the reference `wisp-js` layout
      (`[username_len u8][password_len u16 le][username][password]`), which
      deviates from the v2 spec text; the deviation is documented in both
      READMEs and code comments
- [x] Blocklists (`HOSTNAME_BLACKLIST`, `PORT_BLACKLIST`), per-connection stream
      cap, per-IP stream rate limiting, configurable MOTD/auth via env vars

## Tier 1 — Performance

- [x] **[P] Buffer tuning.** `S`, low risk. Raise the per-stream flow-control
      window to 512 packets (worker `queue_size`, was 128): fewer CONTINUE round
      trips per RTT, measurably higher throughput. The client has no fixed
      `max_buffer_size` — it trusts the server's CONTINUE grant, so it climbs
      automatically. Re-ran the backpressure and CONTINUE tests after the
      change.
- [x] **[P][R] Server: downstream overload policy.** `M`. Wisp CONTINUE credits
      only ever gate client→server data, so a client that stops consuming
      saturates Cloudflare's ws buffers and dies with a late, unexplained
      `NETWORK_ERROR` (0x03). Replaced the platform backstop with a bounded
      per-stream tcp→ws buffer (`DOWNSTREAM_BUFFER`, `wisp.js`
      `drain_downstream`) and a proactive CLOSE (0x03) once a full queue
      persists past `DOWNSTREAM_STALL_TIMEOUT`. The TCP reader pauses while
      the buffer is full, letting TCP backpressure reach the remote producer.
- [x] **[P] Metrics/observability.** `M`. Expose counters (streams, bytes,
      rejects, buffer fill) via a lightweight `/__metrics` endpoint so the
      other performance items are validated with data instead of guesses.
      Counters are per-isolate and in-memory (`metrics.js`), plain-text
      prometheus-style, `?reset=1` for a clean window, `405` for other methods.
- [ ] **[P] Wire coalescing.** `L`. Batch small tcp→ws DATA frames to amortize
      per-message overhead for bulk transfers, without hurting interactive
      latency. Pair with buffer tuning.
- [x] **[P][R] Client: handshake timeout.** `S`. Currently a live-but-silent
      server hangs the connection forever: the client never fires `open` and
      reports no error (`wisp.js`, `connect_ws`), and the v1 fallback only
      triggers on a ws `error`/`close`. Fail with an `error` event + ws close
      when INFO / v1 CONTINUE(0) has not arrived within a configurable
      `HANDSHAKE_TIMEOUT`, after one v1 fallback attempt.
- [x] **[P][F] Client: surface stream-open confirmation.** `S`. The server
      already offers extension `0x05` and sends a per-stream CONTINUE once the
      socket is connected, but the client only uses it to refill `buffer_size`
      (`wisp.js`, `continue_received`). Emit an `open` event on `WispStream`
      and expose `await stream.ready` so callers can detect slow/failed
      CONNECT early instead of inferring from first data or a close.

## Tier 2 — Resilience and resource protection

- [x] **[R] Client: bound `send_buffer`.** `S`. When the server stops granting
      CONTINUE credits, the client pushes into an **unbounded** `send_buffer`
      until OOM (`wisp.js`, `WispStream.send`). Cap it; past the cap, close the
      stream with an error instead of growing memory.
- [x] **[R] Client + server: liveness/keepalive.** `M`. The client has no
      keepalive, timeout, or idle cleanup; the worker relies on Cloudflare's
      default TCP idle timeout (~7 min) because it never passes `idleTimeout`
      to `socket.connect()` (`net.js`). Client: periodic keepalive + report a
      dropped peer as a close with an error. Server: configurable
      `STREAM_IDLE_TIMEOUT` + explicit `idleTimeout` on `connect()`.
- [ ] **[R][S] Server: bandwidth cap.** `M`. Add a per-IP byte-rate token budget
      alongside the stream-count limit so a single client cannot saturate the
      free-tier quota (the inverse of Tier-1 buffering).
- [x] **[S] Server: rate-limit failed auth attempts.** `S`. Wrong/missing
      password handshakes (`0xc0`/`0xc2`) are not counted today; only opened
      streams are. Add a per-IP failed-handshake counter and close with `0x49`
      (throttled) past the threshold.
- [ ] **[S][R] Worker: global rate limiting.** `M`. The current limiter is
      per-isolate and in-memory (`src/ratelimit.js`), so it is bypassable
      across isolates/regions. Move per-IP counters to a Durable Object for a
      single, globally consistent window.
- [x] **[F][P] Client: reconnect/backoff.** `M`. Connection-level auto reconnect
      with exponential backoff on failed or dropped connections, optional
      `fallback_urls` failover rotation, bounded retries
      (`reconnect_max_attempts`), and a `reconnecting` event per attempt. A
      deliberate `close()` and a rejected handshake never reconnect; the client
      resets the backoff once a reconnected connection opens. Streams are
      closed with `NETWORK_ERROR` on a drop and re-created by the app on the
      fresh connection's `open` event.

## Tier 3 — Features and hardening

- [ ] **[F] Dynamic curl option control.** `M` + wasm rebuild. Today only a
      fixed allowlist of JSON keys in `client/libcurl/http.c` reaches
      `curl_easy_setopt`; the raw option is not exported to JS
      (`client/exported_funcs.txt`). Add a typed JS→C bridge
      (`set_curl_option(handle, "CURLOPT_TIMEOUT", 30)` /
      `{opt, type: "long"|"string"|"header-list"|"blob", value}`) with a C-side
      allowlist (no raw pointers/callbacks), applying only to per-request easy
      handles before a transfer starts. The JSON `params` mapping stays the
      canonical surface; this is the escape hatch.
- [x] **[S] Server: destination allowlist.** `S`. Optional `ALLOW_HOSTNAME`
      allowlist to complement the blocklist (exact + subdomain match, IP
      literals verbatim; non-matching destinations close with `0x48`).
- [x] **[S] Server: HTTP(S) hygiene.** `S`. Enforce `wss://`/redirect plain
      HTTP to HTTPS so credentials and traffic are never in clear. Non-loopback
      plain requests get a `308` redirect; `ws://` upgrades get `426`
      (`index.js` `https_policy`, `ENFORCE_HTTPS`, default on, localhost
      exempt for dev). Documented; covered by `test/http.test.js`.
- [ ] **[F][S] Public/private key auth (extension `0x03`).** `L`. ECDSA
      challenge-response using WebCrypto on the client and `crypto.subtle` on
      the worker, replacing shared-secret distribution.
- [ ] **[F] Half-close support.** `L`. Wisp CLOSE is whole-stream today; an
      independent directional shutdown would require a spec extension or a
      higher-level framing layer.
- [ ] **[F] UDP streams.** `L`, deferred. Currently blocked (`block_udp`);
      would require the warp connector on Cloudflare and a UDP-capable
      transport design.

## Known limitations (not planned)

- DNS for hostnames is resolved by the Cloudflare edge at `connect()` time, so
  loopback/private checks only apply to IP literals (`server/worker-wisp-server/src/net.js`).
  Mitigations: destination allowlist, WAF rules in front of the worker.