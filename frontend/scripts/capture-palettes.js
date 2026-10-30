const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs/promises");

const PALETTES = ["neon", "sage", "graphite"];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 760,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const outputDir = path.join(__dirname, "../outputs/palettes");
  await fs.mkdir(outputDir, { recursive: true });

  await win.loadFile(path.join(__dirname, "../src/index.html"));
  await new Promise((resolve) => setTimeout(resolve, 600));

  await win.webContents.executeJavaScript(`
    document.getElementById("onboardingModal").classList.add("hidden");
    applyVideos([
      { name: "episode_01.mp4", path: "episode_01.mp4", url: "" },
      { name: "episode_02.mp4", path: "episode_02.mp4", url: "" }
    ]);
    showView("files");
  `);
  await new Promise((resolve) => setTimeout(resolve, 350));

  for (const palette of PALETTES) {
    for (const theme of ["dark", "light"]) {
      await win.webContents.executeJavaScript(`
        setTheme("${theme}");
        setPalette("${palette}");
      `);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await fs.writeFile(
        path.join(outputDir, `${palette}-${theme}.png`),
        (await win.webContents.capturePage()).toPNG()
      );
    }
  }
  app.quit();
});
