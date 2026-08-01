// The ONE browser-download mechanism in the Console (Settings "Export everything", the Erase page's
// export-first, and the ledger's filtered-view export). `export` is a single JSON bundle incl. raw,
// loopback-only, with NO import — this is the only copy, so it goes straight to a downloaded file
// (build-notes §4).
//
// `downloadTextFile` was factored out of `downloadExport` when the ledger export landed (#78): three
// download sites and one mechanism. This repo has been bitten three times by a second implementation
// that merely agreed with the first at the start, so a new download reuses this and does not grow its
// own Blob/anchor dance. `downloadExport`'s behaviour is unchanged — same filename shape, same
// pretty-printed JSON, same mime.

import { api } from "../../api/client";

/** Hand `text` to the browser as a file. Synchronous; the browser's own download UI is the receipt. */
export function downloadTextFile(filename: string, mime: string, text: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function downloadExport(): Promise<void> {
  const bundle = await api.exportBundle();
  downloadTextFile(
    `postern-export-${new Date().toISOString().slice(0, 10)}.json`,
    "application/json",
    JSON.stringify(bundle, null, 2),
  );
}
