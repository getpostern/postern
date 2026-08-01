// Route: /sectors/finance/merges/:bankKey — confirm a cross-provider merge. It is the finance lens
// with the confirm-a-merge block shown, targeting the bankKey from the path. The block joins to its
// candidate pair by bankKey EQUALITY (build-notes §12.3), never by re-deriving dedup in the client.

import { useParams } from "react-router-dom";
import { SectorLens } from "./SectorLens";

export function ConfirmMergePage(): JSX.Element {
  const { bankKey } = useParams();
  return <SectorLens sector="finance" mergeBankKey={bankKey ?? ""} />;
}
