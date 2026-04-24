/* eslint-disable */
/* Tweaks panel — surfaces when toolbar toggle is on */
import React from 'react';
import { Icon } from './Icon.jsx';

const TweaksPanel = ({ tweaks, setTweaks, onClose }) => {
  const set = (k, v) => setTweaks({ ...tweaks, [k]: v });
  return (
    <div className="tweaks">
      <h4>
        Tweaks
        <button className="close" onClick={onClose}><Icon name="x" size={14}/></button>
      </h4>

      <div className="tweak-row">
        <label>Accent</label>
        <div className="swatches">
          {[
            { k: "coral", c: "#E8553D" },
            { k: "indigo", c: "#4F46E5" },
            { k: "ink", c: "#17171A" },
            { k: "violet", c: "#8B5CF6" },
          ].map((s) => (
            <button
              key={s.k}
              className={"swatch " + (tweaks.accent === s.k ? "active" : "")}
              style={{ background: s.c }}
              onClick={() => set("accent", s.k)}
              aria-label={s.k}
            />
          ))}
        </div>
      </div>

      <div className="tweak-row">
        <label>Theme</label>
        <div className="toggle" onClick={() => set("dark", !tweaks.dark)} data-on={tweaks.dark}>
          <span className={"toggle " + (tweaks.dark ? "on" : "")} style={{margin: 0, border: 0, background: "transparent"}}>
          </span>
        </div>
      </div>

      <div className="tweak-row">
        <label>Typography</label>
        <div className="seg-mini">
          <button className={tweaks.font === "geist-instrument" ? "on" : ""} onClick={() => set("font", "geist-instrument")}>Geist·Inst</button>
          <button className={tweaks.font === "inter-fraunces" ? "on" : ""} onClick={() => set("font", "inter-fraunces")}>Inter·Fr</button>
          <button className={tweaks.font === "mono-serif" ? "on" : ""} onClick={() => set("font", "mono-serif")}>Mono·Inst</button>
        </div>
      </div>

      <div className="tweak-row">
        <label>Density</label>
        <div className="seg-mini">
          <button className={tweaks.density === "dense" ? "on" : ""} onClick={() => set("density", "dense")}>Dense</button>
          <button className={tweaks.density === "airy" ? "on" : ""} onClick={() => set("density", "airy")}>Airy</button>
          <button className={tweaks.density === "spacious" ? "on" : ""} onClick={() => set("density", "spacious")}>Spacious</button>
        </div>
      </div>

      <div className="tweak-row">
        <label>Hero variant</label>
        <div className="seg-mini">
          <button className={tweaks.heroVariant === "gradient" ? "on" : ""} onClick={() => set("heroVariant", "gradient")}>Gradient</button>
          <button className={tweaks.heroVariant === "minimal" ? "on" : ""} onClick={() => set("heroVariant", "minimal")}>Minimal</button>
        </div>
      </div>

      <div className="tweak-row">
        <label>Brief assist</label>
        <span className={"toggle " + (tweaks.showBriefAssist ? "on" : "")} onClick={() => set("showBriefAssist", !tweaks.showBriefAssist)}/>
      </div>
    </div>
  );
};

export { TweaksPanel };
