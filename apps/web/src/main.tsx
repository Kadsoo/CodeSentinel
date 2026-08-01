import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("WEB_ROOT_MISSING");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
