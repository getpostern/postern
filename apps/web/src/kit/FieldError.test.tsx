// FieldError provider-kind: we NEVER paraphrase a provider error (build-notes §14.1d). The literal
// string is quoted verbatim, in mono (<code>), because it is exactly what the operator searches for.

import "../api/test-dom";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FieldError } from "./FieldError";

afterEach(cleanup);

describe("FieldError", () => {
  it("provider quotes THEIR string verbatim in a <code>, and states OUR sentence plainly", () => {
    const theirs = "AUTHENTICATIONFAILED · invalid credentials";
    const { container } = render(
      <FieldError kind="provider" ourSentence="Apple refused it." theirString={theirs} />,
    );

    // Our plain sentence is present…
    expect(screen.getByText("Apple refused it.")).toBeTruthy();

    // …and their string is rendered byte-for-byte, in a mono <code> element, unparaphrased.
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.tagName).toBe("CODE");
    expect(code!.textContent).toBe(theirs);
  });

  it("shape and already kinds render their message and no <code>", () => {
    const shape = render(<FieldError kind="shape" message="That's the bridge address." />);
    expect(screen.getByText("That's the bridge address.")).toBeTruthy();
    expect(shape.container.querySelector("code")).toBeNull();
    cleanup();

    const already = render(<FieldError kind="already" message="This account is already connected." />);
    expect(screen.getByText("This account is already connected.")).toBeTruthy();
    expect(already.container.querySelector("code")).toBeNull();
  });
});
