// Route: /sectors/:sector — the six sector lenses. Validates the path param to a known sector (route
// params arrive as string) and renders the shared <SectorLens>. The mother wires this into App.tsx.

import { useNavigate, useParams } from "react-router-dom";
import { isSector } from "../../api/types";
import { ZeroState } from "../../kit";
import { SectorLens } from "./SectorLens";
import styles from "./lens.module.css";

export function SectorLensPage(): JSX.Element {
  const { sector } = useParams();
  const navigate = useNavigate();

  if (!sector || !isSector(sector)) {
    return (
      <div className={styles.lens}>
        <ZeroState
          headline="No such sector"
          reason={`“${sector ?? ""}” is not one of the six domains this gateway serves.`}
          kind="unconnected"
          action={{ label: "Back to the Gatehouse", onAct: () => navigate("/") }}
        />
      </div>
    );
  }

  return <SectorLens sector={sector} />;
}
