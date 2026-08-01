// ConnectRecipes — "Connect an agent" (Paper 2IG-0). One endpoint, three targets, chosen by how the
// harness reaches the gateway (#71): Local·stdio, Remote·bearer (http-tailnet), Hosted·claude.ai and
// ChatGPT (http-cloud-bridge — both witnessed on the bridge, 2026-08-01). Three things this fixes:
//   - The recipe is DECOUPLED from the shown-once secret: the remote config shows a `<your key>`
//     placeholder, so viewing/copying "how to connect" never requires minting or rotating a key.
//     The copy is marked keyless.
//   - The endpoint is the one the GATEWAY reports (`/api/exposure` → `localEndpoint`) — the MCP edge
//     is a SEPARATE server from the REST origin with no fixed REST↔MCP offset, so it can be neither
//     derived nor baked in at build time. It is served, or it is honestly absent; never guessed.
//   - The remote block is a COMPLETE `mcpServers` config object, not a fragment (#101). A pasted
//     fragment is not a config file, and `transport: "streamable-http"` is a key no MCP client
//     config schema reads — `type: "http"` is the Streamable-HTTP discriminator in the `mcpServers`
//     shape (Claude Code `.mcp.json`, Cursor `mcp.json`). The server contract it matches, verified
//     against the code: the edge serves `/mcp` only (src/mcp/http.ts) over Streamable HTTP, gated by
//     a plain `Authorization: Bearer <token>` (src/mcp/bearer.ts).
//
// And the stdio column states the truth instead of a dead tag (#101): the gateway that serves this
// Console already owns its stdin (src/index.ts boots the StdioServerTransport in the same process),
// so nothing can attach to it — and under the Docker quickstart that process is PID 1 in a container.
// A second gateway on the host would generate its own vault master key and open no stored
// credential. So: no command, for any environment. Route the reader to Remote · bearer instead.

import { SectionRule } from "../../shell";
import { Link } from "react-router-dom";
import { Skeleton, useToast } from "../../kit";
import { useExposure } from "../../api/hooks";
import { EXPOSURE_UNANSWERED } from "../../api/exposure";
import styles from "./ConnectRecipes.module.css";

/** The bearer the KEYLESS recipe carries — a shape to fill in, never a secret. */
export const AGENT_KEY_PLACEHOLDER = "<your-agent-key>";

/**
 * The remote-MCP config, complete and pasteable — **the ONE derivation of the `mcpServers` block
 * shape**, for every surface that hands one over.
 *
 * `endpoint` is the MCP URL the gateway reports. `agentKey` fills the bearer and is the ONLY thing
 * that varies between the two surfaces:
 *
 *   · **omitted** → the placeholder, which is what this page needs: "how to connect" must stay
 *     decoupled from the shown-once secret, so viewing or copying it never requires minting (#71).
 *   · **passed** → the real key, on the reveal-once mint screen (#139) — the one moment in the
 *     product where a plaintext key exists, and therefore the one place a block can be handed over
 *     complete, with nothing left to splice in by hand.
 *
 * A second hand-rolled JSON shape on that screen is the #111 defect waiting to happen (consolidating
 * a derivation is not done until every consumer reads it), so it calls this. The default keeps the
 * register's output byte-identical: a one-argument call returns exactly the string it always did.
 */
export function remoteConfigJson(endpoint: string, agentKey?: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        postern: {
          type: "http",
          url: endpoint,
          headers: { Authorization: `Bearer ${agentKey ?? AGENT_KEY_PLACEHOLDER}` },
        },
      },
    },
    null,
    2,
  );
}

/** Why stdio is unreachable from a gate that is already running. Stated, never worked around. */
const STDIO_WHY =
  "stdio only works when your agent launches Postern itself, as its own child process. The gateway serving this Console is already running and already owns its stdin — nothing can attach to it, and under the Docker quickstart there is no stdin to reach at all.";

/** The marker that replaces the dead `transport: stdio` tag. Deliberately NOT the words "not
 *  served" — that phrase is reserved for facts about the wire (api/notserved.test.ts), and this is
 *  a fact about process ownership. */
const STDIO_UNAVAILABLE = "not available from a running gate";

/** Served, and served as an absence: no MCP edge on this gateway, so there is no recipe to give.
 *  **Only rendered when the gateway ANSWERED** — it ends in an instruction to change the box, and a
 *  failed request is no grounds for one (§Decision 7). That case renders EXPOSURE_UNANSWERED. */
const NO_ENDPOINT =
  "This gateway isn’t serving MCP, so it has no address to point an agent at. Set MCP_HTTP_PORT on the box and restart it.";

export function ConnectRecipes({ endpoint }: { endpoint?: string } = {}): JSX.Element {
  // The gateway reports its own MCP address; the prop is the test/caller override. A pending read
  // renders a <Skeleton>, NEVER a fallback address — handing out a guessed endpoint is the defect
  // this whole change exists to remove. A FAILED read is its own third state: "the gateway did not
  // answer" and "the gateway answered: no MCP edge" have different remedies, and this component
  // used to print the second one's remedy ("Set MCP_HTTP_PORT on the box and restart it") twice,
  // in response to an ECONNREFUSED.
  const exposure = useExposure();
  const pending = endpoint === undefined && exposure.isPending;
  const failed = endpoint === undefined && !pending && (exposure.isError || exposure.data == null);
  const url = failed ? null : (endpoint ?? exposure.data?.localEndpoint ?? null);
  const toast = useToast();
  // ONE call, rendered and copied — never a second stringify that can drift from what's on screen.
  const recipe = url != null ? remoteConfigJson(url) : null;

  const copy = (text: string, msg: string) => {
    void navigator?.clipboard?.writeText?.(text).then(
      () => toast.show({ message: msg }),
      () => toast.show({ message: "Couldn't copy — select and copy manually.", tone: "error" }),
    );
  };

  return (
    <section className={styles.section} aria-label="Connect an agent">
      {/* "harness" is this repo's word for the thing an agent runs in; a person says "my agent", or
          names it — Claude Code, Cursor, claude.ai, ChatGPT (#106). */}
      <SectionRule label="Connect an agent" gloss="one endpoint, any agent" />

      {/* The MCP endpoint — keyless; copying it needs no mint. */}
      <div className={styles.endpoint}>
        <div className={styles.endpointText}>
          <div className={styles.endpointLabel}>MCP endpoint</div>
          {pending ? (
            <Skeleton width="60%" />
          ) : url != null ? (
            <div className={styles.endpointValue}>{url}</div>
          ) : (
            <p className={styles.pathBody}>{failed ? EXPOSURE_UNANSWERED : NO_ENDPOINT}</p>
          )}
        </div>
        {url != null ? (
          <button
            type="button"
            className={styles.copyBtn}
            onClick={() => copy(url, "Endpoint copied")}
          >
            Copy
          </button>
        ) : null}
      </div>

      {/* Three targets, chosen by reachability. Each is a <section> with an accessible name, which
          exposes role="region" — the handle the tests address a column by. */}
      <div className={styles.paths}>
        <section className={styles.path} aria-label="Local · stdio">
          <div className={styles.pathLabel}>Local · stdio</div>
          <div className={styles.unavailable}>{STDIO_UNAVAILABLE}</div>
          <p className={styles.pathBody}>{STDIO_WHY}</p>
          <p className={styles.pathBody}>
            Use <strong>Remote · bearer</strong> instead — same gateway, same tools, one pasted key.
          </p>
        </section>

        <div className={styles.divider} aria-hidden="true" />

        <section className={styles.path} aria-label="Remote · bearer">
          <div className={styles.pathLabel}>Remote · bearer</div>
          <p className={styles.pathBody}>
            Paste a minted key into your agent's config. It opens exactly that key's grants, nothing
            else.
          </p>
          {pending ? (
            <Skeleton lines={3} />
          ) : recipe != null ? (
            <>
              <pre className={styles.recipe}>
                <code>{recipe}</code>
              </pre>
              <button
                type="button"
                className={styles.recipeCopy}
                onClick={() => copy(recipe, "Recipe copied — paste your key where marked")}
              >
                Copy recipe · keyless
              </button>
              <p className={styles.pathBody}>
                Paste the whole object into your agent's MCP config — Claude Code's{" "}
                <code>.mcp.json</code>, Cursor's <code>mcp.json</code> — then restart it.
              </p>
            </>
          ) : (
            // No served address means no config object. A recipe with a guessed URL in it is worse
            // than none: it is pasteable, and it silently does not work.
            <p className={styles.pathBody}>{failed ? EXPOSURE_UNANSWERED : NO_ENDPOINT}</p>
          )}
        </section>

        <div className={styles.divider} aria-hidden="true" />

        <section className={styles.path} aria-label="Hosted · claude.ai, ChatGPT">
          <div className={styles.pathLabel}>Hosted · claude.ai, ChatGPT</div>
          <p className={styles.pathBody}>
            Strict clients connect through the built-in OAuth bridge — add the URL, sign in, paste
            your key once. Revoke kills the derived tokens too.
          </p>
          <p className={styles.pathBody}>
            Needs a public https address on port 443 — hosted clients reach you from their own cloud,
            and they egress on 443 only.
          </p>
          <Link className={styles.pathLink} to="/agents/connect/hosted">
            Set up the bridge →
          </Link>
        </section>
      </div>
    </section>
  );
}
