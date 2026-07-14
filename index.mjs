import fs from 'fs/promises';

// 1. CONFIGURATION
const PLAYLIST_SOURCES = [
  "https://jiotv2.blendersbd.workers.dev/", // Replace with your URLs
  "https://zee5.blendersbd.workers.dev/"
];

const OUTPUT_FILE = "master.m3u";
const CONCURRENCY_LIMIT = 15; // GitHub Actions VMs have plenty of resources for 15 concurrent requests
const REQUEST_TIMEOUT_MS = 3000;

// 2. PARSE M3U PLAYLISTS
function parseM3U(content) {
  const lines = content.split('\n');
  const channels = [];
  let currentChannel = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      currentChannel = {
        info: line,
        properties: [],
        url: ""
      };
    } else if (line.startsWith('#KODIPROP:') || line.startsWith('#EXTVLCOPT:')) {
      if (currentChannel) {
        currentChannel.properties.push(line);
      }
    } else if (!line.startsWith('#')) {
      if (currentChannel) {
        currentChannel.url = line;
        channels.push(currentChannel);
        currentChannel = null;
      }
    }
  }
  return channels;
}

// 3. CHECK STREAM PLAYABILITY
async function isStreamPlayable(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    let response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal
    });

    if (!response.ok) {
      response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: { Range: "bytes=0-0" } 
      });
    }

    clearTimeout(timeoutId);
    return response.ok;
  } catch (error) {
    clearTimeout(timeoutId);
    return false;
  }
}

// 4. CONCURRENT BATCH PROCESSOR
async function filterActiveChannels(channels) {
  const activeChannels = [];
  const total = channels.length;
  let index = 0;

  console.log(`Checking ${total} unique channels...`);

  async function worker() {
    while (index < total) {
      const currentIndex = index++;
      const channel = channels[currentIndex];
      
      const isAlive = await isStreamPlayable(channel.url);
      
      if (isAlive) {
        console.log(`[✓] ALIVE: ${channel.url}`);
        activeChannels.push(channel);
      } else {
        console.log(`[✗] DEAD:  ${channel.url}`);
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY_LIMIT }, worker);
  await Promise.all(workers);

  return activeChannels;
}

// 5. CORE EXECUTION
async function run() {
  console.log(`[${new Date().toISOString()}] Initiating master playlist check...`);
  let allChannels = [];

  for (const source of PLAYLIST_SOURCES) {
    try {
      console.log(`Fetching: ${source}`);
      const response = await fetch(source);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const parsed = parseM3U(text);
      allChannels = allChannels.concat(parsed);
    } catch (err) {
      console.error(`Failed to load source ${source}:`, err.message);
    }
  }

  const uniqueChannels = Array.from(
    new Map(allChannels.map(channel => [channel.url, channel])).values()
  );

  const activeChannels = await filterActiveChannels(uniqueChannels);

  let m3uContent = "#EXTM3U\n\n";
  for (const channel of activeChannels) {
    m3uContent += `${channel.info}\n`;
    if (channel.properties.length > 0) {
      m3uContent += `${channel.properties.join('\n')}\n`;
    }
    m3uContent += `${channel.url}\n\n`;
  }

  await fs.writeFile(OUTPUT_FILE, m3uContent, 'utf-8');
  console.log(`Completed. Saved ${activeChannels.length} active channels to ${OUTPUT_FILE}`);
}

run();