import { useState } from "react";
import { Canvas } from "@react-three/fiber";
import { MappingPanel } from "./MappingPanel";
import { MappingScene } from "./MappingScene";

export function MappingApp() {
  const [selected, setSelected] = useState<number | null>(null);
  const [selectedGaussianId, setSelectedGaussianId] = useState<string | null>(
    null,
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "#05070d" }}>
      <Canvas
        camera={{ position: [0.28, 0.02, 0.42], fov: 35 }}
        dpr={[1, 2]}
        gl={{ antialias: true }}
      >
        <color attach="background" args={["#05070d"]} />
        <MappingScene
          selected={selected}
          setSelected={setSelected}
          selectedGaussianId={selectedGaussianId}
          setSelectedGaussianId={setSelectedGaussianId}
        />
      </Canvas>
      <MappingPanel
        selected={selected}
        setSelected={setSelected}
        selectedGaussianId={selectedGaussianId}
        setSelectedGaussianId={setSelectedGaussianId}
      />
    </div>
  );
}
