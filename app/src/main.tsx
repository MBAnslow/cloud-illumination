import ReactDOM from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router-dom";
import App from "./App";
import { MappingApp } from "./mapping/MappingApp";
import { startPersistence } from "./state/persistRuntime";
import { SkyClockRuntime } from "./state/SkyClockRuntime";

startPersistence();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <HashRouter>
    <SkyClockRuntime />
    <Routes>
      <Route path="/" element={<App />} />
      <Route path="/mapping" element={<MappingApp />} />
    </Routes>
  </HashRouter>,
);
