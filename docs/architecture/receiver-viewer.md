# Receiver viewer API

The viewer serves a verified original from the same origin as the receiver. It has no public job listing or upload controls. Only jobs with status `received` and a receipt can issue a viewing link or deliver content.

## Mobile entry route

After receipt confirmation, the mobile app calls `POST /jobs/:id/view` with the job's original `Authorization: Bearer <capability>` header. The response is HTTP 200:

```json
{"path":"/receive#<64 lowercase hex characters>"}
```

The app opens that relative path on its configured receiver origin in the browser. The fragment contains a random, read-only exchange code, not the original capability. A retry or a second browser needs a new viewing link. The mobile app must not add the capability to a URL.

Missing authorization returns 401. A different capability returns 403. A job without a verified receipt returns 409. Unknown jobs return 404 after capability syntax validation. `GET /jobs/:id/view` is not supported.

## Browser exchange

`GET /receive` returns the screening-room HTML. `HEAD /receive` returns its headers without a body. The document contains no job data or credentials.

The inline script removes the fragment with `history.replaceState` before any network request. It exchanges the code with:

```http
POST /viewer/session
Content-Type: application/json

{"code":"<64 lowercase hex characters>"}
```

A successful exchange returns 204 and no response body. Its cookie has these attributes:

```http
Set-Cookie: footage_viewer=<random session>; Path=/viewer/; HttpOnly; SameSite=Strict; Max-Age=600
```

A TLS request also sets `Secure`. Cleartext viewing requests require a private or loopback socket peer. Allowed peers include RFC 1918 IPv4, IPv4 link-local, IPv6 unique-local, and IPv6 link-local addresses. A private address is not proof that a network is trusted. The HTTP entrypoint is intended only for a trusted private network.

TLS detection uses the actual request socket, not `Forwarded` or `X-Forwarded-Proto`. The existing entrypoint serves HTTP. TLS terminated at a proxy is not detected as receiver TLS, so such a deployment needs a trusted TLS integration before use beyond the private-network scope.

The code expires after two minutes and succeeds once, including concurrent exchange attempts. Missing or malformed code JSON returns 400. Invalid, expired, or used codes return 401. Original capabilities and session values do not work as exchange codes. Non-JSON content returns 415, metadata over 4096 bytes returns 413, and a supplied cross-origin `Origin` returns 403.

The session expires ten minutes after exchange and does not renew on use. A browser with a current cookie can reload `/receive` without a fragment. The code and session maps each hold at most 256 grants. Expired grants are pruned on access. Capacity exhaustion returns 503 without evicting active grants or consuming an exchange code. Receiver restart invalidates both maps. Only token hashes are stored in memory.

`createReceiver(directory, options)` accepts optional `viewerCodeTtlMs` and `viewerSessionTtlMs` lifetimes. Defaults are 120000 and 600000 milliseconds. Values must be whole milliseconds between zero and one day. Zero disables usable access for that credential lifetime and permits deterministic expiry tests without a production bypass.

## Received metadata

`GET /viewer/job` requires the session cookie. Its HTTP 200 JSON has exactly these fields:

```ts
{
	id: string;
	name: string;
	bytes: number;
	sha256: string;
	status: 'received';
	receipt: {
		id: string;
		jobId: string;
		bytes: number;
		sha256: string;
		verifiedAt: string; // ISO timestamp
	};
	contentType: 'video/mp4' | 'video/webm' | 'video/ogg' | 'application/octet-stream';
	previewSupported: boolean;
	contentPath: '/viewer/content';
	downloadPath: '/viewer/content?download=1';
}
```

No upload path, capability, session value, or stored token hash is returned. The page sets the filename, receipt, and hash through `textContent`, never HTML interpolation. Preview support identifies the container, not browser codec support. Unknown formats show an explicit unsupported-preview message. Browser decode errors preserve the original download link.

## Original content

`GET /viewer/content` and `HEAD /viewer/content` require the session cookie. Recognized video containers use an inline disposition. `/viewer/content?download=1` uses an attachment disposition with the original filename encoded as RFC 5987 UTF-8. Unknown formats always use an attachment disposition and `application/octet-stream`.

The existing `GET /jobs/:id/content` now also supports `HEAD` and ranges. These routes still require the original Bearer capability and always use an attachment disposition. Viewer cookies, exchange codes, and session values never authorize the original job API.

Both content routes use the same streaming implementation:

- Full responses return 200, the original byte length, and `Accept-Ranges: bytes`.
- A single `Range: bytes=start-end`, `bytes=start-`, or `bytes=-suffix` returns 206 with `Content-Range` and the selected length.
- An end beyond the original is clamped to its last byte. A suffix larger than the file returns the entire original with status 206.
- Malformed, multiple, reversed, zero-suffix, unsafe-integer, or outside ranges return 416 and `Content-Range: bytes */<original length>`.
- `HEAD` returns the same status and content headers as `GET`, without content bytes.
- A bounded 4096-byte read identifies supported MP4 `ftyp` brands, WebM EBML with its document type, or Ogg magic. Extensions do not select the content type.
- A file stream reads only the selected range. Playback never reads the entire original into memory and never holds the per-job mutation lock.

Authorization runs before range handling. Missing, malformed, unknown, or expired viewer credentials return 401. Credential-like query parameters and Bearer headers do not authorize viewer routes. Unsupported viewer methods return 405 after session authorization. Content for incomplete, failed, or cancelled jobs returns 409 through the authorized job API.

Expiry applies to each new HTTP request. A stream admitted before expiry can finish. Received originals remain immutable, and cancellation cannot contradict an existing receipt.

## Response security

HTML, metadata, content, and errors use `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and `X-Frame-Options: DENY`. The CSP permits only the hashed local script and stylesheet, same-origin metadata requests, and same-origin media. It prohibits framing, base URLs, and forms.

No credential is placed in a content URL, local storage, or application logs. The exchange code exists only in the initial fragment and JSON exchange body. Proxy request-body and cookie logging must also remain disabled. The existing tus `handleWeb(new NodeRequest({ req, res }))` disconnect handling is unchanged.

## Verification

`npm test --workspace=@footage/server` includes the original 15 HTTP tests and the viewer integration tests. Fixtures create temporary receiver directories and do not use live uploads. `npm run typecheck --workspace=@footage/server` checks the server and tests.
