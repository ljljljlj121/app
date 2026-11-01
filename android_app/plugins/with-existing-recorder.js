const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod, withMainApplication } = require("expo/config-plugins");

module.exports = function withExistingRecorder(config) {
  config = withMainApplication(config, (mod) => {
    const registration = "add(WavRecorderPackage())";
    if (!mod.modResults.contents.includes(registration)) {
      const anchor = "PackageList(this).packages.apply {";
      if (!mod.modResults.contents.includes(anchor)) throw new Error("Cannot locate React Native package registration");
      mod.modResults.contents = mod.modResults.contents.replace(anchor, `${anchor}\n              ${registration}`);
    }
    return mod;
  });
  return withDangerousMod(config, ["android", async (mod) => {
    const source = path.join(mod.modRequest.projectRoot, "native", "wav-recorder");
    const target = path.join(mod.modRequest.platformProjectRoot, "app/src/main/java/com/robotprize/datacollection");
    fs.mkdirSync(target, { recursive: true });
    for (const name of ["WavRecorderModule.kt", "WavRecorderPackage.kt"]) {
      fs.copyFileSync(path.join(source, name), path.join(target, name));
    }
    return mod;
  }]);
};
