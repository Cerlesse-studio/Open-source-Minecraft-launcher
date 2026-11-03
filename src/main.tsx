import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { setLanguage } from "./lib/i18n";
import { loadSettings } from "./lib/settings";
import "./styles.css";

// Apply the saved interface language before the first paint so returning
// English users do not see one Chinese frame during hydration.
setLanguage(loadSettings().language);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
