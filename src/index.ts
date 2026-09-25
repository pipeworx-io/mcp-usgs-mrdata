interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * USGS MRData MCP — the Mineral Resources Data System (MRDS)
 *
 * MRDS is the USGS inventory of metallic and non-metallic mineral resources
 * worldwide: ~300,000 records of mines, prospects, occurrences and processing
 * plants, with commodity, deposit type, development status, production and
 * bibliographic detail. Keyless.
 *
 * Site: https://mrdata.usgs.gov/mrds/
 *
 * Endpoints used:
 *   /services/wfs/mrds            — OGC WFS 1.0.0 point layer, for SEARCH
 *   /mrds/json/<dep_id>           — full record for ONE deposit, as GeoJSON
 *
 * TRAPS worth knowing, all learned from live calls while building this:
 *   - The WFS speaks GML ONLY. `outputformat=geojson` and `application/json`
 *     are both rejected by name; the only formats advertised are GML 2.1.2 and
 *     GML 3.1.1. So search results are parsed out of XML here.
 *   - Use version=1.0.0 for bbox queries. WFS 1.1.0 flips the axis order to
 *     lat,lon and a 1.0.0-style bbox silently returns ZERO features rather
 *     than erroring — the classic empty-looks-like-no-data failure.
 *   - `PropertyIsEqualTo` on dep_id fails with a server-side query error
 *     (the column is not a text type in the backing store). `PropertyIsLike`
 *     with no wildcard works and is what this pack uses for exact lookup.
 *   - The per-deposit JSON is a PATH, /mrds/json/<dep_id>, not a query
 *     parameter — /mrds/json/?dep_id=... answers HTTP 400 with an empty body.
 *   - The WFS point layer carries only a summary: dep_id, site_name, dev_stat,
 *     fips_code, huc_code, quad_code, url and a space-separated `code_list` of
 *     commodity symbols. Everything else (deposit type, production, references)
 *     is in the per-deposit record.
 */


const UA = 'pipeworx-mcp-usgs-mrdata/1.0 (+https://pipeworx.io)';
const BASE = 'https://mrdata.usgs.gov';
const WFS = `${BASE}/services/wfs/mrds`;

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'USGS MRData');
}

/**
 * MRDS commodity codes, as they actually appear in the WFS `code_list` field.
 * Taken from a 4,000-site sample of the western US, not from the periodic
 * table: MRDS codes non-metals with THREE letters (SDG, STN, CLY, LST) and
 * qualifies them with a suffix (STN_C crushed stone, CLY_BN bentonite,
 * PGE_PT platinum). Assuming two-letter element symbols throughout is wrong
 * and leaves the commonest codes in the database unnamed.
 */
const COMMODITY_NAMES: Record<string, string> = {
  // Metals and elements
  AG: 'Silver', AL: 'Aluminum', AS: 'Arsenic', AU: 'Gold', B: 'Boron', BA: 'Barium-Barite',
  BE: 'Beryllium', BI: 'Bismuth', BR: 'Bromine', CA: 'Calcium', CD: 'Cadmium', CE: 'Cerium',
  CL: 'Chlorine', CO: 'Cobalt', CR: 'Chromium', CS: 'Cesium', CU: 'Copper',
  F: 'Fluorine-Fluorspar', FE: 'Iron', GA: 'Gallium', GE: 'Germanium', HF: 'Hafnium',
  HG: 'Mercury', IN: 'Indium', K: 'Potassium', LI: 'Lithium', MG: 'Magnesium',
  MN: 'Manganese', MO: 'Molybdenum', NA: 'Sodium', NB: 'Niobium', ND: 'Neodymium',
  NI: 'Nickel', P: 'Phosphorus-Phosphate', PB: 'Lead', RA: 'Radium', RE: 'Rhenium',
  REE: 'Rare Earth Elements', S: 'Sulfur', SB: 'Antimony', SC: 'Scandium', SE: 'Selenium',
  SI: 'Silicon', SN: 'Tin', SR: 'Strontium', TA: 'Tantalum', TE: 'Tellurium',
  TH: 'Thorium', TI: 'Titanium', TL: 'Thallium', U: 'Uranium', V: 'Vanadium',
  W: 'Tungsten', Y: 'Yttrium', ZN: 'Zinc', ZR: 'Zirconium',
  // Platinum group — the base code plus the per-metal qualifiers
  PGE: 'Platinum-Group Elements', PGE_PT: 'Platinum', PGE_PD: 'Palladium',
  PGE_IR: 'Iridium', PGE_OS: 'Osmium', PGE_RH: 'Rhodium', PGE_RU: 'Ruthenium',
  // Industrial minerals, construction materials and energy
  ABR: 'Abrasive', ABR_G: 'Abrasive, Garnet', ASB: 'Asbestos', CLY: 'Clay',
  CLY_BN: 'Clay, Bentonite', CLY_FR: 'Clay, Fire Clay', CLY_K: 'Clay, Kaolin',
  COA: 'Coal', COA_L: 'Coal, Lignite', DIT: 'Diatomite', DOL: 'Dolomite',
  FLD: 'Feldspar', GEM: 'Gemstone', GEM_D: 'Gemstone, Diamond', GEM_SP: 'Gemstone, Sapphire',
  GEO: 'Geothermal', GRF: 'Graphite', GRT: 'Garnet', GYP: 'Gypsum', KYN: 'Kyanite',
  LST: 'Limestone', LST_C: 'Limestone, Cement', LST_D: 'Limestone, Dolomitic',
  LWA: 'Lightweight Aggregate', MBL: 'Marble', MIC: 'Mica', NA_S: 'Sodium, Salt',
  OIL_SA: 'Oil Sand', PER: 'Perlite', PUM: 'Pumice', QTZ: 'Quartz',
  SDG: 'Sand and Gravel', SIL: 'Silica', STN: 'Stone', STN_C: 'Stone, Crushed-Broken',
  STN_D: 'Stone, Dimension', STN_F: 'Stone, Flagstone', S_P: 'Sulfur, Pyrite',
  TLC: 'Talc', TRA: 'Traprock', VOL: 'Volcanic Material', VRM: 'Vermiculite',
  W_C: 'Tungsten, Scheelite-Wolframite', ZEO: 'Zeolites',
};

/**
 * MRDS qualifies a commodity with an underscore suffix (STN_C, CLY_BN). When a
 * qualified code is not in the table, fall back to its base so the caller gets
 * "Stone" rather than a bare code; an unknown base stays as the code itself,
 * which is honest about what we do not have a name for.
 */
function commodityName(code: string): string {
  const exact = COMMODITY_NAMES[code];
  if (exact) return exact;
  const base = code.split('_')[0];
  return COMMODITY_NAMES[base] ?? code;
}

const tools: McpToolExport['tools'] = [
  {
    name: 'mrdata_search_deposits',
    description:
      'Search the USGS Mineral Resources Data System for mines, prospects and mineral occurrences by bounding box, site name or commodity. AUTHORITATIVE for "what has been mined near here" and "where are the US lithium/copper/gold occurrences" — returns each site\'s deposit id, name, development status (Producer, Past Producer, Prospect, Occurrence), coordinates and commodity codes. Sourced from USGS MRData.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        bbox: { type: 'string', description: 'Bounding box "minLon,minLat,maxLon,maxLat" (WGS84), e.g. "-112.2,33.4,-112.0,33.6"' },
        name_contains: { type: 'string', description: 'Site-name substring, case-sensitive as stored, e.g. "Bingham", "Rico"' },
        commodity: { type: 'string', description: 'Commodity symbol as MRDS codes it, e.g. "AU" (gold), "CU" (copper), "LI" (lithium), "REE". List them with mrdata_commodities.' },
        limit: { type: 'number', description: 'Max sites to return (default 25, max 200)' },
      },
    },
  },
  {
    name: 'mrdata_deposit',
    description:
      'Full USGS MRDS record for one mineral deposit by its deposit id — commodities with their roles, deposit type and model, development status, operation type, mining method, years of first and last production, discovery method, alternate site names, host rocks, ore and gangue minerals, and the bibliography behind the record. Sourced from USGS MRData.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dep_id: { type: 'string', description: 'MRDS deposit id, e.g. "10186774". Get one from mrdata_search_deposits.' },
        sections: { type: 'string', description: 'Comma-separated sections to keep, e.g. "deposits,commodity,name". Omit for the whole record.' },
      },
      required: ['dep_id'],
    },
  },
  {
    name: 'mrdata_commodities',
    description:
      'Which commodities are recorded in USGS MRDS inside an area, with a site count per commodity — the "what is this region mined for" tool. Also serves as the lookup for the commodity symbols that mrdata_search_deposits expects. Sourced from USGS MRData.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        bbox: { type: 'string', description: 'Bounding box "minLon,minLat,maxLon,maxLat" (WGS84). Omit to get the symbol reference list with no counts.' },
        sample_size: { type: 'number', description: 'How many sites in the box to tally (default 500, max 2000)' },
      },
    },
  },
];

function clampLimit(v: unknown, def: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(max, Math.floor(n));
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function tagText(block: string, tag: string): string | null {
  const m = new RegExp(`<ms:${tag}>([\\s\\S]*?)</ms:${tag}>`).exec(block);
  return m ? decodeXml(m[1]).trim() || null : null;
}

interface Deposit {
  dep_id: string | null;
  site_name: string | null;
  development_status: string | null;
  longitude: number | null;
  latitude: number | null;
  commodity_codes: string[];
  commodities: string[];
  fips_code: string | null;
  huc_code: string | null;
  quad_code: string | null;
  url: string | null;
}

function commodityNames(codes: string[]): string[] {
  return codes.map(commodityName);
}

function parseWfs(xml: string): Deposit[] {
  const err = /<(?:ows:)?ExceptionText>([\s\S]*?)<\/(?:ows:)?ExceptionText>|<ServiceException[^>]*>([\s\S]*?)<\/ServiceException>/.exec(xml);
  if (err) throw new Error(`USGS MRData WFS error: ${decodeXml((err[1] ?? err[2] ?? '').trim()).slice(0, 250)}`);
  const out: Deposit[] = [];
  for (const m of xml.matchAll(/<gml:featureMember>([\s\S]*?)<\/gml:featureMember>/g)) {
    const block = m[1];
    const pt = /<gml:Point[^>]*>[\s\S]*?<gml:coordinates>([^<]*)<\/gml:coordinates>/.exec(block);
    const coords = pt ? pt[1].trim().split(',').map(Number) : [];
    const codes = (tagText(block, 'code_list') ?? '').split(/\s+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
    out.push({
      dep_id: tagText(block, 'dep_id'),
      site_name: tagText(block, 'site_name'),
      development_status: tagText(block, 'dev_stat'),
      longitude: Number.isFinite(coords[0]) ? coords[0] : null,
      latitude: Number.isFinite(coords[1]) ? coords[1] : null,
      commodity_codes: codes,
      commodities: commodityNames(codes),
      fips_code: tagText(block, 'fips_code'),
      huc_code: tagText(block, 'huc_code'),
      quad_code: tagText(block, 'quad_code'),
      url: tagText(block, 'url'),
    });
  }
  return out;
}

/**
 * Always version 1.0.0. In WFS 1.1.0 the EPSG:4326 axis order is lat,lon, so a
 * lon,lat bbox answers 200 with zero features and no error at all.
 */
async function wfsGetFeature(extra: Record<string, string>, maxFeatures: number): Promise<Deposit[]> {
  const p = new URLSearchParams({
    service: 'WFS',
    version: '1.0.0',
    request: 'GetFeature',
    typename: 'mrds',
    maxfeatures: String(maxFeatures),
    ...extra,
  });
  const res = await pwFetch(`${WFS}?${p}`, { headers: { Accept: 'text/xml' } });
  if (!res.ok) throw new Error(`USGS MRData error ${res.status}`);
  return parseWfs(await res.text());
}

function bboxParam(bbox: string): string {
  const p = bbox.split(',').map((x) => Number(x.trim()));
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) {
    throw new Error('bbox must be four numbers "minLon,minLat,maxLon,maxLat", e.g. "-112.2,33.4,-112.0,33.6".');
  }
  return p.join(',');
}

async function searchDeposits(args: Record<string, unknown>) {
  const limit = clampLimit(args.limit, 25, 200);
  const extra: Record<string, string> = {};
  const filters: string[] = [];

  if (typeof args.bbox === 'string' && args.bbox.trim()) extra.bbox = bboxParam(args.bbox);
  if (typeof args.name_contains === 'string' && args.name_contains.trim()) {
    filters.push(
      `<PropertyIsLike wildCard="*" singleChar="." escapeChar="!"><PropertyName>site_name</PropertyName><Literal>*${xmlEscape(args.name_contains.trim())}*</Literal></PropertyIsLike>`,
    );
  }
  if (typeof args.commodity === 'string' && args.commodity.trim()) {
    const code = args.commodity.trim().toUpperCase();
    filters.push(
      `<PropertyIsLike wildCard="*" singleChar="." escapeChar="!"><PropertyName>code_list</PropertyName><Literal>*${xmlEscape(code)}*</Literal></PropertyIsLike>`,
    );
  }
  if (!extra.bbox && filters.length === 0) {
    throw new Error('Give at least one of bbox, name_contains or commodity — MRDS holds ~300,000 sites and an unfiltered query is not useful.');
  }
  // WFS 1.0.0 cannot combine a bbox parameter with a filter parameter, so when
  // both are asked for, filter server-side and intersect the box here.
  if (filters.length > 0) {
    const body = filters.length === 1 ? filters[0] : `<And>${filters.join('')}</And>`;
    const bbox = extra.bbox;
    delete extra.bbox;
    extra.filter = `<Filter>${body}</Filter>`;
    const over = bbox ? Math.min(2000, limit * 20) : limit;
    let rows = await wfsGetFeature(extra, over);
    if (bbox) {
      const [minLon, minLat, maxLon, maxLat] = bbox.split(',').map(Number);
      rows = rows.filter(
        (d) => d.longitude !== null && d.latitude !== null &&
          d.longitude >= minLon && d.longitude <= maxLon && d.latitude >= minLat && d.latitude <= maxLat,
      );
    }
    return shape(rows, limit, args);
  }
  return shape(await wfsGetFeature(extra, limit), limit, args);
}

function shape(rows: Deposit[], limit: number, args: Record<string, unknown>) {
  const kept = rows.slice(0, limit);
  return {
    count: kept.length,
    total_matched: rows.length,
    truncated: rows.length > kept.length,
    query: {
      bbox: (args.bbox as string) ?? null,
      name_contains: (args.name_contains as string) ?? null,
      commodity: (args.commodity as string) ?? null,
    },
    deposits: kept,
    source: 'USGS Mineral Resources Data System (MRDS) — https://mrdata.usgs.gov/mrds/',
  };
}

async function deposit(args: Record<string, unknown>) {
  const id = args.dep_id;
  if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).trim()) {
    throw new Error('Required argument "dep_id" is missing. Pass an MRDS deposit id like "10186774" — get one from mrdata_search_deposits.');
  }
  const depId = String(id).trim();
  if (!/^\d+$/.test(depId)) throw new Error(`dep_id must be numeric (got ${JSON.stringify(depId)}).`);
  const url = `${BASE}/mrds/json/${depId}`;
  const res = await pwFetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 404 || res.status === 400) {
    throw new Error(`USGS MRDS has no deposit record with id ${depId}.`);
  }
  if (!res.ok) throw new Error(`USGS MRData error ${res.status} for deposit ${depId}`);
  const body = (await res.json()) as { geometry?: { coordinates?: [number, number] }; properties?: Record<string, unknown> };
  let props = body.properties ?? {};
  if (typeof args.sections === 'string' && args.sections.trim()) {
    const want = new Set(args.sections.split(',').map((s) => s.trim()).filter(Boolean));
    props = Object.fromEntries(Object.entries(props).filter(([k]) => want.has(k)));
    if (Object.keys(props).length === 0) {
      throw new Error(`None of the requested sections exist on deposit ${depId}. Available: ${Object.keys(body.properties ?? {}).join(', ')}.`);
    }
  }
  const c = body.geometry?.coordinates;
  return {
    dep_id: depId,
    longitude: c?.[0] ?? null,
    latitude: c?.[1] ?? null,
    sections: Object.keys(props),
    record: props,
    record_url: `${BASE}/mrds/show-mrds.php?dep_id=${depId}`,
    source: 'USGS Mineral Resources Data System (MRDS) — https://mrdata.usgs.gov/mrds/',
  };
}

async function commodities(args: Record<string, unknown>) {
  const reference = Object.entries(COMMODITY_NAMES)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.code.localeCompare(b.code));
  if (typeof args.bbox !== 'string' || !args.bbox.trim()) {
    return {
      counted: false,
      note: 'No bbox given, so this is the commodity-symbol reference list only. Pass a bbox to get site counts per commodity for an area.',
      count: reference.length,
      commodities: reference,
      source: 'USGS Mineral Resources Data System (MRDS) — https://mrdata.usgs.gov/mrds/',
    };
  }
  const sample = clampLimit(args.sample_size, 500, 2000);
  const rows = await wfsGetFeature({ bbox: bboxParam(args.bbox) }, sample);
  const tally = new Map<string, number>();
  for (const d of rows) for (const c of new Set(d.commodity_codes)) tally.set(c, (tally.get(c) ?? 0) + 1);
  const ranked = [...tally.entries()]
    .map(([code, sites]) => ({ code, name: commodityName(code), sites }))
    .sort((a, b) => b.sites - a.sites);
  return {
    counted: true,
    bbox: args.bbox,
    sites_sampled: rows.length,
    sample_capped: rows.length >= sample,
    count: ranked.length,
    commodities: ranked,
    source: 'USGS Mineral Resources Data System (MRDS) — https://mrdata.usgs.gov/mrds/',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'mrdata_search_deposits':
      return searchDeposits(args);
    case 'mrdata_deposit':
      return deposit(args);
    case 'mrdata_commodities':
      return commodities(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
