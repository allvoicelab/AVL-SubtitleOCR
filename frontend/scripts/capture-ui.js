const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs/promises");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 760,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  const outputDir = path.join(__dirname, "../outputs");
  await fs.mkdir(outputDir, { recursive: true });

  await win.loadFile(path.join(__dirname, "../src/index.html"));
  await new Promise((resolve) => setTimeout(resolve, 600));
  await fs.writeFile(path.join(outputDir, "ui-onboarding.png"), (await win.webContents.capturePage()).toPNG());

  await win.webContents.executeJavaScript(`
    document.getElementById("onboardingModal").classList.add("hidden");
  `);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await fs.writeFile(path.join(outputDir, "ui-main.png"), (await win.webContents.capturePage()).toPNG());

  await win.webContents.executeJavaScript(`
    applyVideos([{ name: "episode_01.mp4", path: "episode_01.mp4", url: "" }]);
    selectFile(state.files[state.files.length - 1].id);
  `);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await fs.writeFile(path.join(outputDir, "ui-subtitles.png"), (await win.webContents.capturePage()).toPNG());

  await win.webContents.executeJavaScript(`
    applyVideos([
      { name: "episode_01.mp4", path: "episode_01.mp4", url: "" },
      { name: "episode_02.mp4", path: "episode_02.mp4", url: "" },
      { name: "episode_03.mp4", path: "episode_03.mp4", url: "" }
    ]);
    showView("files");
  `);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await fs.writeFile(path.join(outputDir, "ui-files.png"), (await win.webContents.capturePage()).toPNG());

  await win.webContents.executeJavaScript(`
    document.getElementById("loadingModal").classList.remove("hidden");
    document.getElementById("progressValue").textContent = "68%";
    document.getElementById("linearProgress").style.width = "68%";
    document.getElementById("progressCircle").style.strokeDashoffset = String(351.86 - 0.68 * 351.86);
  `);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await fs.writeFile(path.join(outputDir, "ui-loading.png"), (await win.webContents.capturePage()).toPNG());

  await win.webContents.executeJavaScript(`
    document.getElementById("loadingModal").classList.add("hidden");
    document.getElementById("errorModal").classList.remove("hidden");
  `);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await fs.writeFile(path.join(outputDir, "ui-error.png"), (await win.webContents.capturePage()).toPNG());

  await win.webContents.executeJavaScript(`
    document.getElementById("errorModal").classList.add("hidden");
    document.getElementById("settingsButton").click();
  `);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await fs.writeFile(path.join(outputDir, "ui-settings.png"), (await win.webContents.capturePage()).toPNG());

  await win.webContents.executeJavaScript(`
    document.getElementById("settingsModal").classList.add("hidden");
    document.getElementById("brandButton").click();
  `);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await fs.writeFile(path.join(outputDir, "ui-about.png"), (await win.webContents.capturePage()).toPNG());

  await win.webContents.executeJavaScript(`
    document.getElementById("aboutModal").classList.add("hidden");
    document.getElementById("brandFollowButton").click();
  `);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await fs.writeFile(path.join(outputDir, "ui-follow.png"), (await win.webContents.capturePage()).toPNG());

  await win.webContents.executeJavaScript(`
    document.querySelector('#followTabs button[data-channel="qq"]').click();
  `);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await fs.writeFile(path.join(outputDir, "ui-follow-qq.png"), (await win.webContents.capturePage()).toPNG());

  await win.webContents.executeJavaScript(`
    document.getElementById("aboutModal").classList.add("hidden");
    document.getElementById("onboardingModal").classList.remove("hidden");
  `);
  win.setSize(860, 620);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await fs.writeFile(path.join(outputDir, "ui-narrow-onboarding.png"), (await win.webContents.capturePage()).toPNG());
  app.quit();
});
