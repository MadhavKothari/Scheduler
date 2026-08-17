import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register the service worker so the app can be installed to a phone's home
// screen and has an offline-capable app shell. Safe to skip in browsers
// without support.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* offline install just won't be available — the app still works online */
    });
  });
}
