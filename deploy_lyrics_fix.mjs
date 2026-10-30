import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, copyFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

function getGitHubToken() {
  const cred = execSync("git credential fill", {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
  });
  for (const line of cred.split("\n")) {
    if (line.startsWith("password=")) return line.slice(9).trim();
  }
  throw new Error("Could not find GitHub token");
}

async function fetchWithRetry(url, options, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, options);
      return res;
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      console.log(`Fetch retry ${i + 1}/${maxRetries} after error: ${e.message}`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
}

const token = getGitHubToken();
const REPO = "Rohitpvt/Cocoa-Notch";
const PROJECT_ROOT = process.cwd();
const GH_DIR = join(PROJECT_ROOT, "windows", "target", "gh_artifacts");
const RELEASE_DIR = join(PROJECT_ROOT, "windows", "release");

mkdirSync(GH_DIR, { recursive: true });
mkdirSync(RELEASE_DIR, { recursive: true });

// Find run for commit 3ef10a2
let runId = null;
for (let attempt = 0; attempt < 15; attempt++) {
  try {
    const res = await fetchWithRetry(`https://api.github.com/repos/${REPO}/actions/runs?per_page=5`, {
      headers: {
        "User-Agent": "Node-Fetch",
        Authorization: `token ${token}`,
      },
    });
    const data = await res.json();
    const match = data.workflow_runs?.find((r) => r.name === "Windows" && r.head_sha.startsWith("3ef10a2"));
    if (match) {
      runId = match.id;
      console.log(`Found Windows run ${runId} for commit 3ef10a2 (status=${match.status})`);
      break;
    }
  } catch (err) {
    console.error("Error fetching runs:", err.message);
  }
  await new Promise((r) => setTimeout(r, 3000));
}

if (!runId) {
  throw new Error("Could not find GitHub workflow run for commit 3ef10a2");
}

console.log(`Waiting for workflow run ${runId} to complete...`);

while (true) {
  try {
    const res = await fetchWithRetry(`https://api.github.com/repos/${REPO}/actions/runs/${runId}`, {
      headers: {
        "User-Agent": "Node-Fetch",
        Authorization: `token ${token}`,
      },
    });
    const run = await res.json();
    const time = new Date().toLocaleTimeString();
    console.log(`[${time}] status=${run.status}, conclusion=${run.conclusion}`);

    if (run.status === "completed") {
      if (run.conclusion !== "success") {
        throw new Error(`Workflow run failed with conclusion: ${run.conclusion}`);
      }
      break;
    }
  } catch (err) {
    console.error("Poll error:", err.message);
  }
  await new Promise((r) => setTimeout(r, 15000));
}

console.log("Workflow run completed successfully! Fetching artifacts...");
const artRes = await fetchWithRetry(`https://api.github.com/repos/${REPO}/actions/runs/${runId}/artifacts`, {
  headers: {
    "User-Agent": "Node-Fetch",
    Authorization: `token ${token}`,
  },
});
const artData = await artRes.json();
console.log(`Found ${artData.artifacts?.length || 0} artifacts.`);

for (const art of artData.artifacts || []) {
  console.log(`Downloading artifact ${art.name}...`);
  const zipRes = await fetchWithRetry(art.archive_download_url, {
    headers: {
      "User-Agent": "Node-Fetch",
      Authorization: `token ${token}`,
    },
  });
  const buf = Buffer.from(await zipRes.arrayBuffer());
  const zipPath = join(GH_DIR, `${art.name}.zip`);
  writeFileSync(zipPath, buf);

  const extractDir = join(GH_DIR, art.name);
  mkdirSync(extractDir, { recursive: true });
  execSync(`tar -xf "${zipPath}" -C "${extractDir}"`);
}

// Kill running Cocoa-Windows process before copying to prevent EBUSY
try {
  execSync("taskkill /IM Cocoa-Windows.exe /F", { stdio: "ignore" });
} catch {}

// Copy extracted files to destination locations
const setupDir = join(GH_DIR, "Cocoa-Windows-setup");
const msiDir = join(GH_DIR, "Cocoa-Windows-msi");
const exeDir = join(GH_DIR, "Cocoa-Windows-exe");

if (existsSync(setupDir)) {
  for (const f of readdirSync(setupDir)) {
    if (f.endsWith(".exe")) {
      const src = join(setupDir, f);
      copyFileSync(src, join(PROJECT_ROOT, "Cocoa-Windows-setup.exe"));
      copyFileSync(src, join(RELEASE_DIR, "Cocoa-Windows-setup.exe"));
      copyFileSync(src, join(RELEASE_DIR, f));
      console.log(`Updated Setup: ${f} -> Cocoa-Windows-setup.exe`);
    }
  }
}

if (existsSync(msiDir)) {
  for (const f of readdirSync(msiDir)) {
    if (f.endsWith(".msi")) {
      const src = join(msiDir, f);
      copyFileSync(src, join(PROJECT_ROOT, "Cocoa-Windows.msi"));
      copyFileSync(src, join(RELEASE_DIR, "Cocoa-Windows.msi"));
      copyFileSync(src, join(RELEASE_DIR, f));
      console.log(`Updated MSI: ${f} -> Cocoa-Windows.msi`);
    }
  }
}

if (existsSync(exeDir)) {
  for (const f of readdirSync(exeDir)) {
    if (f.endsWith(".exe")) {
      const src = join(exeDir, f);
      copyFileSync(src, join(PROJECT_ROOT, "Cocoa-Windows.exe"));
      copyFileSync(src, join(RELEASE_DIR, "Cocoa-Windows.exe"));
      console.log(`Updated Portable: ${f} -> Cocoa-Windows.exe`);
    }
  }
}

console.log("All binaries successfully updated from GitHub Actions build!");
