// The nine connect screens — ONE template, four custody shapes (build-notes §2). The route
// `/connect/:provider` resolves a catalog slug and renders the shared skeleton (back-link →
// masthead → two columns → creates footer); only the right card varies by custody.
//
// The three connect-failure kinds (build-notes §14.1d) via <FieldError>:
//   • ours     — validateShape rejects before a round-trip; the field seals, the message says what
//                right looks like.
//   • theirs    — the provider's RestError string, rendered VERBATIM in mono, never paraphrased.
//   • nobody's  — already-connected; no seal, no red, states what will happen + requires intent (#55).

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Copyable, FieldError, ZeroState, useToast } from "../../kit";
import { useConnectors } from "../../api/hooks";
import { RestError, api } from "../../api/client";
import type { PlaidAppStatus, PlaidConnectedItem } from "../../api/client";
import type { ConnectorStatus } from "../../api/types";
import { providerBySlug, type ConnectField, type ProviderDef } from "./catalog";
import { HEALTH_PUSH_TEMPLATE } from "./ingestPayload";
import { StepsColumn, CreatesFooter, ProviderTileBox } from "./parts";
import {
  errorMessage,
  openInNewTab,
  prepareOAuth,
  redirectTo,
  runDevice,
  runPaste,
  startPlaid,
  useRedirectUri,
  validateShape,
  type ConnectValues,
  type DeviceResult,
} from "./connectApi";
import styles from "./connect.module.css";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

// ─────────────────────────────────────────────────────────────────────────────
// Route entry
// ─────────────────────────────────────────────────────────────────────────────

export function ConnectProvider(): JSX.Element {
  const { provider } = useParams<{ provider: string }>();
  const def = providerBySlug(provider);
  const navigate = useNavigate();

  if (!def) {
    return (
      <div className={`${styles.page} ${styles.pageConnect}`}>
        <Link className={styles.backLink} to="/connect">
          ← Add a source
        </Link>
        <ZeroState
          headline="No such source"
          reason={
            <>
              Postern doesn’t have a connector called <code>{provider}</code>. Pick one from Add a
              source.
            </>
          }
          kind="unconnected"
          action={{ label: "Back to Add a source", onAct: () => navigate("/connect") }}
        />
      </div>
    );
  }
  return <ConnectScreen def={def} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// The shared screen skeleton
// ─────────────────────────────────────────────────────────────────────────────

/** The live (non-revoked) connections for this provider — the connection-awareness input (#55). */
function useExisting(providerKey: string): ConnectorStatus[] {
  const { data } = useConnectors();
  return (data ?? []).filter((c) => c.provider === providerKey && c.status !== "revoked");
}

function ConnectScreen({ def }: { def: ProviderDef }): JSX.Element {
  const existing = useExisting(def.providerKey);
  // Asked unconditionally (hooks may not be conditional) — `null` on a non-OAuth screen issues no
  // request at all. The gateway is the ONE source of the redirect URI it will send (ADR 0035 §D4);
  // this screen displays what it is told and derives nothing.
  const redirectUri = useRedirectUri(def.oauthProvider ?? null);
  return (
    <div className={`${styles.page} ${styles.pageConnect}`}>
      <Link className={styles.backLink} to="/connect">
        ← Add a source
      </Link>

      <div className={styles.cxMasthead}>
        <div className={styles.kicker}>Connect</div>
        <div className={styles.cxHeadRow}>
          <ProviderTileBox def={def} variant="masthead" />
          <div className={styles.cxNameCol}>
            <div className={styles.cxName}>{def.name}</div>
            <div className={styles.cxSub}>{def.mastheadSub}</div>
          </div>
        </div>
      </div>

      <div className={styles.body}>
        <StepsColumn def={def} redirectUri={redirectUri} />
        {def.custody === "paste" ? (
          <PasteForm def={def} existing={existing} />
        ) : def.custody === "oauth" ? (
          <OAuthForm def={def} existing={existing} />
        ) : def.custody === "plaid" ? (
          <PlaidForm def={def} existing={existing} />
        ) : (
          <DeviceForm def={def} existing={existing} />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared form pieces
// ─────────────────────────────────────────────────────────────────────────────

let fieldSeq = 0;

function FieldInput({
  field,
  value,
  onChange,
  errorMessage: err,
  disabled,
}: {
  field: ConnectField;
  value: string;
  onChange: (v: string) => void;
  errorMessage?: string;
  disabled?: boolean;
}): JSX.Element {
  const idRef = useRef<string>();
  if (!idRef.current) idRef.current = `connect-field-${fieldSeq++}`;
  const id = idRef.current;
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={id}>
        {field.label}
      </label>
      <input
        id={id}
        className={cx(styles.input, field.mono && styles.inputMono, err && styles.inputError)}
        type={field.secret ? "password" : "text"}
        value={value}
        placeholder={field.placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={err ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {/* An always-visible constraint the placeholder can't carry (#96 §3) — before the error, so a
          sealed field still shows what right looks like. Not an error: never sealed, never red. */}
      {field.hint ? <div className={styles.fieldHint}>{field.hint}</div> : null}
      {err ? <FieldError kind="shape" message={err} /> : null}
    </div>
  );
}

/** The nobody's-failure banner (#55/#14.1d): already-connected, stated plainly with a route to
 *  manage — no seal, no red. */
function AlreadyNotice({
  message,
  connectionId,
}: {
  message: ReactNode;
  connectionId?: string;
}): JSX.Element {
  return (
    <FieldError
      kind="already"
      message={
        <>
          {message}
          {connectionId ? (
            <>
              {" "}
              <Link className={styles.manageLink} to={`/sources/${connectionId}`}>
                Manage this connection →
              </Link>
            </>
          ) : null}
        </>
      }
    />
  );
}

/** Turn a thrown value into the "theirs" failure — the provider's own string, verbatim, in mono. */
function providerFailure(def: ProviderDef, err: unknown): { our: string; their: string } {
  if (err instanceof RestError) return { our: `${def.name} refused it.`, their: err.message };
  return { our: "Couldn’t reach the gateway.", their: errorMessage(err) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Paste-token form (iCloud · Gmail · SimpleFIN · Home Assistant)
// ─────────────────────────────────────────────────────────────────────────────

function PasteForm({ def, existing }: { def: ProviderDef; existing: ConnectorStatus[] }): JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();
  const [values, setValues] = useState<ConnectValues>({});
  const [shapeField, setShapeField] = useState<keyof ConnectValues | null>(null);
  const [shapeMsg, setShapeMsg] = useState<string | null>(null);
  const [their, setTheir] = useState<{ our: string; their: string } | null>(null);
  // A connection that WAS created but whose first read failed (#96 §4). Not a `their` failure: the
  // connect succeeded, so the copy is "it exists and its first read did not work" — and the repair
  // (re-check the address, re-paste the token) is on this screen, so we stay here.
  const [firstSyncFail, setFirstSyncFail] = useState<{ connectionId: string; message: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState(false);

  const isConnected = existing.length > 0;
  const gate = isConnected; // reconnect requires explicit intent (#55)
  const set = (wire: keyof ConnectValues, v: string) =>
    setValues((prev) => ({ ...prev, [wire]: v }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setTheir(null);
    setFirstSyncFail(null);
    const shape = validateShape(def, values);
    if (shape) {
      setShapeField(shape.field);
      setShapeMsg(shape.message);
      return;
    }
    setShapeField(null);
    setShapeMsg(null);
    setBusy(true);
    try {
      const res = await runPaste(def, values);
      if (res.firstSync.kind === "failed") {
        // No success toast, no navigate: a toast on /sources would be gone in seconds and would
        // leave the user on a row with no data and no explanation.
        setFirstSyncFail({ connectionId: res.connectionIds[0], message: res.firstSync.message });
        return;
      }
      toast.show({ message: `${def.name} connected.` });
      navigate("/sources");
    } catch (err) {
      setTheir(providerFailure(def, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <div className={styles.formHeader}>{def.formHeader}</div>

      {isConnected ? (
        <AlreadyNotice message={alreadyText(def, existing)} connectionId={existing[0]?.connectionId} />
      ) : null}

      {def.fields.map((field) => (
        <FieldInput
          key={field.wire}
          field={field}
          value={values[field.wire] ?? ""}
          onChange={(v) => set(field.wire, v)}
          errorMessage={shapeField === field.wire ? shapeMsg ?? undefined : undefined}
        />
      ))}

      {gate ? <IntentCheckbox label={intentLabel(def)} checked={intent} onChange={setIntent} /> : null}

      <button className={styles.submit} type="submit" disabled={busy || (gate && !intent)}>
        {busy ? "Connecting…" : isConnected ? `Reconnect ${def.name}` : def.cta}
      </button>

      {their ? <FieldError kind="provider" ourSentence={their.our} theirString={their.their} /> : null}

      {firstSyncFail ? (
        <>
          <FieldError
            kind="provider"
            ourSentence={`${def.name} is connected, but its first sync failed.`}
            theirString={firstSyncFail.message}
          />
          <Link
            className={styles.manageLink}
            to={`/sources/${encodeURIComponent(firstSyncFail.connectionId)}`}
          >
            Manage this connection →
          </Link>
        </>
      ) : null}

      <div className={styles.divider} aria-hidden="true" />
      <CreatesFooter sectors={def.sectors} line={def.createsLine} />
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth form (Microsoft · Google · Whoop) — save the BYO app, redirect to consent
// ─────────────────────────────────────────────────────────────────────────────

function OAuthForm({ def, existing }: { def: ProviderDef; existing: ConnectorStatus[] }): JSX.Element {
  // A FAILED consent 302s back to THIS screen with the provider's own code (#96 §1.6) — the repair
  // (re-read the registration steps, re-paste the client id/secret) is what this screen renders.
  //
  // DERIVED, not stored, and deliberately no effect and no URL stripping: the URL IS the state, a
  // refresh legitimately re-shows the failure, and the user leaves by submitting (a full-page
  // redirect) or navigating away. Zero effects here is zero white-screen risk (no ErrorBoundary).
  const [searchParams] = useSearchParams();
  const returnedError = searchParams.get("oauth_error");
  const [values, setValues] = useState<ConnectValues>({});
  const [shapeField, setShapeField] = useState<keyof ConnectValues | null>(null);
  const [shapeMsg, setShapeMsg] = useState<string | null>(null);
  const [their, setTheir] = useState<{ our: string; their: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState(false);

  const isConnected = existing.length > 0;
  const gate = isConnected;
  const set = (wire: keyof ConnectValues, v: string) =>
    setValues((prev) => ({ ...prev, [wire]: v }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setTheir(null);
    const shape = validateShape(def, values);
    if (shape) {
      setShapeField(shape.field);
      setShapeMsg(shape.message);
      return;
    }
    setShapeField(null);
    setShapeMsg(null);
    setBusy(true);
    try {
      const url = await prepareOAuth(def, values);
      redirectTo(url); // full-page redirect to the provider's consent
    } catch (err) {
      setTheir(providerFailure(def, err));
      setBusy(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <div className={styles.formHeader}>{def.formHeader}</div>

      {/* The provider's literal code, rendered VERBATIM in <code> — never paraphrased (§14.1d). */}
      {returnedError ? (
        <FieldError
          kind="provider"
          ourSentence={`${def.name} did not complete the sign-in.`}
          theirString={returnedError}
        />
      ) : null}

      {isConnected ? (
        <AlreadyNotice message={alreadyText(def, existing)} connectionId={existing[0]?.connectionId} />
      ) : null}

      {def.fields.map((field) => {
        // The secret field is disabled for a public client (Microsoft) — the reason is the ghost text,
        // not a bare dim (build-notes §1.5).
        const isSecret = field.wire === "clientSecret";
        const disabled = isSecret && !def.confidential;
        return (
          <FieldInput
            key={field.wire}
            field={field}
            value={disabled ? "" : values[field.wire] ?? ""}
            onChange={(v) => set(field.wire, v)}
            disabled={disabled}
            errorMessage={shapeField === field.wire ? shapeMsg ?? undefined : undefined}
          />
        );
      })}

      {gate ? <IntentCheckbox label={intentLabel(def)} checked={intent} onChange={setIntent} /> : null}

      <button className={styles.submit} type="submit" disabled={busy || (gate && !intent)}>
        {busy ? "Redirecting…" : isConnected ? `Reconnect ${def.name}` : def.cta}
      </button>

      {their ? <FieldError kind="provider" ourSentence={their.our} theirString={their.their} /> : null}

      <div className={styles.divider} aria-hidden="true" />
      <CreatesFooter sectors={def.sectors} line={def.createsLine} />
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Plaid form (BYO app + hosted Link) — save app, mint hosted link, poll for banks
// ─────────────────────────────────────────────────────────────────────────────

function PlaidForm({ def, existing }: { def: ProviderDef; existing: ConnectorStatus[] }): JSX.Element {
  const [values, setValues] = useState<ConnectValues>({});
  const [appStatus, setAppStatus] = useState<PlaidAppStatus | null>(null);
  const [shapeField, setShapeField] = useState<keyof ConnectValues | null>(null);
  const [shapeMsg, setShapeMsg] = useState<string | null>(null);
  const [their, setTheir] = useState<{ our: string; their: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [hostedUrl, setHostedUrl] = useState<string | null>(null);
  const [banks, setBanks] = useState<PlaidConnectedItem[]>([]);
  const [complete, setComplete] = useState(false);

  const set = (wire: keyof ConnectValues, v: string) =>
    setValues((prev) => ({ ...prev, [wire]: v }));

  useEffect(() => {
    let live = true;
    api
      .plaidAppStatus()
      .then((s) => {
        if (live) setAppStatus(s);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // Poll the hosted-link session for the banks the operator authenticates (the authoritative signal).
  useEffect(() => {
    if (!linkToken || complete) return;
    const id = setInterval(async () => {
      try {
        const res = await api.plaidPoll(linkToken);
        setBanks(res.connections);
        if (res.complete) setComplete(true);
      } catch {
        /* transient; keep polling */
      }
    }, 2500);
    return () => clearInterval(id);
  }, [linkToken, complete]);

  const configured = appStatus?.configured ?? false;
  const secretGiven = (values.clientSecret ?? "").trim().length > 0;
  // When the app is already configured and the operator leaves the secret blank, reuse the sealed app
  // (the secret is never returned) and just mint a new hosted link.
  const reuseApp = configured && !secretGiven;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setTheir(null);
    if (reuseApp) {
      setShapeField(null);
      setShapeMsg(null);
    } else {
      const shape = validateShape(def, values);
      if (shape) {
        setShapeField(shape.field);
        setShapeMsg(shape.message);
        return;
      }
      setShapeField(null);
      setShapeMsg(null);
    }
    setBusy(true);
    try {
      const link = reuseApp ? await api.plaidHostedLink() : await startPlaid(values);
      setLinkToken(link.linkToken);
      setHostedUrl(link.hostedLinkUrl);
      openInNewTab(link.hostedLinkUrl);
    } catch (err) {
      setTheir(providerFailure(def, err));
    } finally {
      setBusy(false);
    }
  };

  if (linkToken) {
    return (
      <div className={styles.form}>
        <div className={styles.formHeader}>Link your banks</div>
        <p className={styles.plaidLead}>
          Plaid Link opened in a new tab — choose your bank(s) and authorise there. Each bank appears
          here as its own connection when you finish; Postern never sees your bank login.
        </p>
        {banks.length === 0 ? (
          <div className={styles.waiting}>
            <span className={styles.waitingDot} aria-hidden="true" />
            waiting for the first bank
          </div>
        ) : (
          <div>
            {banks.map((b) => (
              <div key={b.connectionId} className={styles.bankRow}>
                <span className={styles.bankName}>{b.institutionName ?? "Bank"}</span>
                <span className={styles.bankMeta}>{b.health?.status ?? "linked"}</span>
              </div>
            ))}
          </div>
        )}
        {hostedUrl ? (
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={() => openInNewTab(hostedUrl)}
          >
            Re-open Plaid Link
          </button>
        ) : null}
        <Link className={styles.submit} to="/sources">
          {complete ? "Done — go to Sources" : `Continue in Sources${banks.length ? ` (${banks.length})` : ""}`}
        </Link>
        <div className={styles.divider} aria-hidden="true" />
        <CreatesFooter sectors={def.sectors} line={def.createsLine} />
      </div>
    );
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <div className={styles.formHeader}>{def.formHeader}</div>

      {existing.length > 0 ? (
        <AlreadyNotice message={alreadyText(def, existing)} connectionId={existing[0]?.connectionId} />
      ) : null}

      {def.fields.map((field) => {
        const prefill =
          field.wire === "clientId" && configured && appStatus?.clientId ? appStatus.clientId : undefined;
        const placeholder =
          field.wire === "clientSecret" && configured
            ? "already sealed — leave blank to keep"
            : field.placeholder;
        return (
          <FieldInput
            key={field.wire}
            field={{ ...field, placeholder }}
            value={values[field.wire] ?? prefill ?? ""}
            onChange={(v) => set(field.wire, v)}
            errorMessage={shapeField === field.wire ? shapeMsg ?? undefined : undefined}
          />
        );
      })}

      <button className={styles.submit} type="submit" disabled={busy}>
        {busy ? "Opening Link…" : reuseApp ? "Add a bank" : def.cta}
      </button>

      {their ? <FieldError kind="provider" ourSentence={their.our} theirString={their.their} /> : null}

      <div className={styles.divider} aria-hidden="true" />
      <CreatesFooter sectors={def.sectors} line={def.createsLine} />
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Device form (Apple Health) — create the endpoint, show the reachable URL + one-time secret (#27)
// ─────────────────────────────────────────────────────────────────────────────

function DeviceForm({ def, existing }: { def: ProviderDef; existing: ConnectorStatus[] }): JSX.Element {
  const [minted, setMinted] = useState<DeviceResult | null>(null);
  const [their, setTheir] = useState<{ our: string; their: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState(false);

  const isConnected = existing.length > 0;
  const gate = isConnected && !minted;

  const onCreate = useCallback(async () => {
    setTheir(null);
    setBusy(true);
    try {
      setMinted(await runDevice(def));
    } catch (err) {
      setTheir(providerFailure(def, err));
    } finally {
      setBusy(false);
    }
  }, [def]);

  return (
    <div className={styles.form}>
      <div className={styles.formHeader}>{def.formHeader}</div>

      {isConnected && !minted ? (
        <AlreadyNotice message={alreadyText(def, existing)} connectionId={existing[0]?.connectionId} />
      ) : null}

      {minted ? (
        <>
          {/* The SERVED ingest PATH — a relative `/api/ingest/<id>` is all the backend returns
              (admin.ts). The reachable BASE is genuinely NOT served: the Console runs on loopback a
              device can't reach, and the remote-access host has no fixed offset from this origin —
              so we show the path honestly and name the host the operator supplies, never dressing
              `localhost:8787` as the endpoint (#27, degradation contract). The artboard's own
              `your-mac.tailnet.ts.net:8443` is exactly this placeholder host. */}
          <Copyable label="Ingest path" value={minted.ingestPath} mono />
          <p className={styles.disabledReason}>
            This is the path your gateway serves. Point your device at it on your gateway’s{" "}
            <strong>remote-access host</strong> — the tailnet or public address you configured, e.g.{" "}
            <code>https://your-mac.tailnet.ts.net:8443{minted.ingestPath}</code>. That host isn’t the
            Console’s <code>localhost</code>, and Postern isn’t told it, so you have to add it yourself.
          </p>
          {/* The value being copied is the SECRET, so that is what the label names. The header it goes
              in is a wire literal the person has to type, so it stays — in the sentence that tells them
              where to put it, not as the label of the thing itself (#106). */}
          <Copyable label="Device secret — shown once" value={minted.secret} mono />
          <p className={styles.secretNote}>
            One secret for this device — treat it like a key. Send it on every push as the{" "}
            <code>X-PCI-Webhook-Secret</code> header. You can rotate it any time from the connection.
          </p>

          {/* THE QR AND THE DEAD BUTTON ARE GONE (#106 §2b/§3). There is no Postern-published shortcut
              and no endpoint that serves one, so the screen drew three empty squares labelled "not
              served" (9px small-caps) beside a disabled button offering to install it — a dead control
              plus a build-status caption, which is the one outcome the issue rules out. Nothing is
              hidden: the instruction that was buried under the button is now the instruction, and the
              payload template below it is what makes it followable. Re-add an affordance here when
              something actually serves a shortcut. */}
          <p className={styles.secretNote}>
            To build it by hand: in the iPhone Shortcuts app, add a “Get Contents of URL” step that
            POSTs the body below to the endpoint above, with that header. Or use Health Auto Export,
            described under the template.
          </p>

          <div className={styles.waiting}>
            <span className={styles.waitingDot} aria-hidden="true" />
            waiting for the first push
          </div>
        </>
      ) : (
        <>
          <p className={styles.secretNote}>
            Postern mints a private ingest endpoint and a one-time secret for this device. Nothing is
            created until you ask.
          </p>
          {gate ? <IntentCheckbox label={intentLabel(def)} checked={intent} onChange={setIntent} /> : null}
          <button
            className={styles.submit}
            type="button"
            onClick={onCreate}
            disabled={busy || (gate && !intent)}
          >
            {busy ? "Creating…" : isConnected ? "Create another endpoint" : def.cta}
          </button>
        </>
      )}

      {/* The payload template (#27's last acceptance item: "no source-diving for the payload").
          Rendered in BOTH states on purpose — it is a static fact about our own ingest contract, not
          a property of a minted endpoint, and the operator who comes back to this screen after the
          first setup lands in the pre-mint branch. Gating it behind a fresh mint would put the one
          thing the issue asks for behind the one action a returning user will not take. */}
      <PayloadTemplate />

      {their ? <FieldError kind="provider" ourSentence={their.our} theirString={their.their} /> : null}

      <div className={styles.divider} aria-hidden="true" />
      <CreatesFooter sectors={def.sectors} line={def.createsLine} />
    </div>
  );
}

/**
 * What to POST — #27 step 4, and the one named acceptance item that kept the issue open. Before this,
 * the screen said only that the Shortcut should post "your Health export", so configuring the
 * automation meant reading `decodePush` in `src/connectors/apple-health.ts`.
 *
 * The issue names the app: **Health Auto Export**, whose REST-API automation already emits exactly
 * this shape. The Shortcuts route stays beside it — the hand-built option is spelled out above, and
 * nothing here replaces it. (What was removed above is the disabled *install* button and its fake QR,
 * not the route: #27 asked for the payload and the automation, never for a shortcut we do not publish.)
 *
 * Deliberately absent: any reachable URL. The ingest HOST is genuinely not derivable from this origin
 * and the MCP public URL is a different edge with no fixed offset, so the body is all this block
 * shows. Also deliberately absent: the webhook secret. It is minted, shown once, and copyable above;
 * naming the header here is not the same as printing the value again.
 */
function PayloadTemplate(): JSX.Element {
  const toast = useToast();
  const copy = () => {
    void navigator?.clipboard?.writeText?.(HEALTH_PUSH_TEMPLATE).then(
      () => toast.show({ message: "Payload template copied" }),
      () => toast.show({ message: "Couldn’t copy — select and copy manually.", tone: "error" }),
    );
  };

  return (
    <div className={styles.payload}>
      <div className={styles.payloadLabel}>The JSON body Postern expects</div>
      <p className={styles.secretNote}>
        Two ways to send it. Postern’s connector is written for the REST export of the{" "}
        <strong>Health Auto Export</strong> iOS app, so that app already produces this shape — point its
        REST API automation at your ingest endpoint and add the <code>X-PCI-Webhook-Secret</code>{" "}
        header. Or build the request yourself in Shortcuts.
      </p>
      <pre className={styles.payloadBlock}>
        <code>{HEALTH_PUSH_TEMPLATE}</code>
      </pre>
      <button type="button" className={styles.payloadCopy} onClick={copy}>
        Copy the template
      </button>
      <p className={styles.secretNote}>
        The keys are what matter, not the values. Each <code>metrics[].name</code> becomes a metric
        type; the metric named <code>sleep_analysis</code> becomes a sleep session; every{" "}
        <code>workouts[]</code> entry needs its own <code>id</code>. Dates are{" "}
        <code>yyyy-MM-dd HH:mm:ss ±hhmm</code>, not ISO — a point Postern can’t date is skipped rather
        than stored wrong. Send <code>Min</code>/<code>Avg</code>/<code>Max</code> instead of{" "}
        <code>qty</code> and you get three daily statistics. Re-posting an overlapping window updates
        the same rows; it never duplicates them.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection-awareness copy (#55) — what re-connecting does, and the intent it requires
// ─────────────────────────────────────────────────────────────────────────────

function IntentCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label className={styles.intentRow}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function alreadyText(def: ProviderDef, existing: ConnectorStatus[]): ReactNode {
  if (def.providerKey === "apple") {
    return "iCloud is already connected — Mail, Calendar and Contacts run from one credential. Connecting again replaces the stored app-specific password; it won’t create a second copy.";
  }
  if (def.custody === "oauth") {
    return `${def.name} is already connected. Signing in again replaces the stored app and re-runs consent — it won’t create a second connection.`;
  }
  if (def.custody === "plaid") {
    const n = existing.length;
    return `You already have ${n} ${n === 1 ? "bank" : "banks"} connected through Plaid. Adding another links a new bank as its own connection — it won’t touch the ones you have.`;
  }
  if (def.custody === "device") {
    return "A device is already pushing Health data here. Create another endpoint only if you’re adding a second device.";
  }
  return `${def.name} is already connected. Connecting again replaces the stored credential — it won’t create a second copy.`;
}

function intentLabel(def: ProviderDef): string {
  if (def.providerKey === "apple") return "Yes — replace the stored app-specific password.";
  if (def.custody === "oauth") return "Yes — replace the stored app and re-run consent.";
  if (def.custody === "device") return "Yes — create a second ingest endpoint.";
  return "Yes — replace the stored credential.";
}
