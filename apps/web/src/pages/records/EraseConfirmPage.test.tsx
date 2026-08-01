// Erase confirm, rendered (#74 + the #17 data-loss lesson). Proves: destruction goes through the
// typed ConfirmBar (never a browser dialog); the seal button is inert until "ERASE" is typed; a
// scope with a target cannot be confirmed until the target is chosen; and the wire body carries the
// right scope + the fat-finger token. Export-first is a real call.

import "../../api/test-dom";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { ConnectorStatus } from "../../api/types";
import { EraseConfirmPage } from "./EraseConfirmPage";

const conn: ConnectorStatus = {
  connectionId: "conn_abcdef12",
  provider: "simplefin",
  sector: "finance",
  status: "active",
  last_synced_at: null,
  last_error: null,
  last_error_at: null,
  policy_mode: "poll",
  next_sync_at: null,
  scopes: [],
  credential: { status: "active", expires_at: null },
  credentialId: "cred_fixture",
  webhook_secret_set_at: null,
  sync_window_days: null,
  sync_interval_sec: null,
  min_interval_sec: null,
  default_interval_sec: null,
  cached_count: 10,
};

function renderErase() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/settings/erase"]}>
        <EraseConfirmPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(api, "listConnectors").mockResolvedValue([conn]);
  // downloadExport reaches for URL.createObjectURL — stub it so the path completes under jsdom.
  Object.defineProperty(URL, "createObjectURL", { value: () => "blob:x", configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("#74 — scope selection and the typed guard", () => {
  it("default (connection) scope withholds the confirm until a connection is chosen", async () => {
    renderErase();
    expect(await screen.findByText("Choose a connection to continue.")).toBeTruthy();
    // No ConfirmBar verb yet.
    expect(screen.queryByRole("button", { name: /^Erase/ })).toBeNull();

    fireEvent.change(await screen.findByLabelText("Which connection to erase"), {
      target: { value: "conn_abcdef12" },
    });
    expect(await screen.findByRole("button", { name: "Erase this connection" })).toBeTruthy();
  });

  it("erase-everything: the seal is inert until export IS taken AND ERASE is typed, then sends the right body", async () => {
    const erase = vi.spyOn(api, "erase").mockResolvedValue({});
    renderErase();

    fireEvent.click(await screen.findByText("Everything"));
    const btn = (await screen.findByRole("button", { name: "Erase everything" })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true); // both guards open

    // Typing the token alone is NOT enough — export-first is enforced (#17).
    fireEvent.change(screen.getByLabelText("Type ERASE to confirm"), { target: { value: "ERASE" } });
    expect(btn.disabled).toBe(true);

    // Take the export → the last guard clears.
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    expect(btn.disabled).toBe(false);

    fireEvent.click(btn);
    await waitFor(() =>
      expect(erase).toHaveBeenCalledWith({ scope: "all", confirm: "ERASE" }),
    );
  });

  it("a wrong token keeps the button disabled (typed guard is exact)", async () => {
    renderErase();
    fireEvent.click(await screen.findByText("Everything"));
    const btn = (await screen.findByRole("button", { name: "Erase everything" })) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText("Type ERASE to confirm"), { target: { value: "erase" } });
    expect(btn.disabled).toBe(true);
  });
});

// ── #134 fix round (F5): an ARMED seal must not survive a retarget ────────────
//
// One ConfirmBar slot serves every scope and requireTyped is the constant "ERASE" — so unkeyed,
// arming the seal for one connection and then clicking the "Everything" scope card yielded an
// ARMED erase-everything with no re-confirmation (the adversarial reviewer's demonstrated worst
// case). The bar is keyed by the erase target, so any retarget is a remount: typed box cleared,
// export gate re-closed.
describe("retargeting the erase disarms the seal (#134/F5)", () => {
  it("armed for connection A + click Everything → disarmed, typed box cleared, export re-required", async () => {
    // MUTATION: drop the `key` off the ConfirmBar in EraseConfirmPage.tsx → every assertion after
    // the retarget goes red (the armed state survives into erase-everything).
    vi.spyOn(api, "exportBundle").mockResolvedValue({ ok: true });
    renderErase();

    // Arm the seal for ONE connection: pick it, export, type the exact token.
    fireEvent.change(await screen.findByLabelText("Which connection to erase"), {
      target: { value: "conn_abcdef12" },
    });
    const sealA = (await screen.findByRole("button", { name: "Erase this connection" })) as HTMLButtonElement;
    fireEvent.click(screen.getByRole("button", { name: "Export first" }));
    fireEvent.change(screen.getByLabelText("Type ERASE to confirm"), { target: { value: "ERASE" } });
    expect(sealA.disabled).toBe(false); // fully armed

    // Retarget to Everything — the scariest scope must re-earn BOTH guards.
    fireEvent.click(screen.getByText("Everything"));
    const sealAll = (await screen.findByRole("button", { name: "Erase everything" })) as HTMLButtonElement;
    expect(sealAll.disabled).toBe(true);
    expect((screen.getByLabelText("Type ERASE to confirm") as HTMLInputElement).value).toBe("");
    // The export gate re-closed too: typing the token alone must not arm erase-everything.
    fireEvent.change(screen.getByLabelText("Type ERASE to confirm"), { target: { value: "ERASE" } });
    expect(sealAll.disabled).toBe(true);
  });
});

describe("the #17 lesson is unmissable, and export-first is a real call", () => {
  it("shows 'no undo and no import' and offers export-first, which calls the export route", async () => {
    const exp = vi.spyOn(api, "exportBundle").mockResolvedValue({ ok: true });
    renderErase();
    fireEvent.click(await screen.findByText("Everything"));
    // The no-undo/no-import truth appears in the masthead AND ConfirmBar's export lead — both, plainly.
    expect((await screen.findAllByText(/no undo and no import/i)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Export first" }));
    await waitFor(() => expect(exp).toHaveBeenCalled());
  });
});
