# Mobile Extension Proxy Engine 🚀

A high-performance, ultra-lightweight proxy engine that allows mobile users to use Chrome Extensions on any website. 

Unlike traditional solutions that run heavy browser instances (like Chromium) on the server, this engine uses a **Script Injection Proxy** architecture. It's designed to support thousands of concurrent users with minimal CPU and RAM usage.

## ✨ Key Features

- **Ultra Lightweight**: No Chromium on the server. CPU and RAM usage are minimal.
- **Chrome Extension Support**: 
  - Provide a **Chrome Web Store ID**.
  - Provide a **direct URL** to a `.crx` file.
  - **Upload** a `.zip` or `.crx` extension file.
- **On-the-fly Injection**: Automatically parses `manifest.json` and injects `content_scripts` and CSS into target websites.
- **Mobile Optimized**: Clean, responsive UI for easy use on smartphones.
- **Session Persistence**: Intercepts navigation and forms to keep the user within the extension-enabled proxy.

## 🚀 Quick Start

### Running with Docker (Recommended)

```bash
# Build the image
docker build -t mobile-extension .

# Run the container
docker run -p 3000:3000 mobile-extension
```

### Manual Installation

1.  **Install dependencies**:
    ```bash
    npm install
    ```
2.  **Start the server**:
    ```bash
    npm start
    ```
3.  **Access**: Open `http://localhost:3000` in your mobile browser.

## 🛠️ How It Works

1.  **Extension Parsing**: The engine downloads and extracts the extension, reading its `manifest.json` to identify which scripts and styles need to be loaded.
2.  **Proxy Layer**: When a user visits a site through the proxy, the server fetches the site's HTML.
3.  **Injection Engine**: Using [cheerio](https://cheerio.js.org/), the server injects the extension's assets and a `window.chrome` API shim into the `<head>` of the page.
4.  **Client-Side Execution**: The heavy lifting (running the JavaScript) happens on the **user's phone**, keeping the server fast and light.

## 📂 Project Structure

- [server.js](server.js): The core proxy and injection logic.
- [Dockerfile](Dockerfile): Optimized `node:20-slim` container configuration.
- [.github/workflows/build.yml](.github/workflows/build.yml): Automated build pipeline.

## ⚠️ Limitations

- **Background Scripts**: Since there is no persistent browser process on the server, extensions relying heavily on `background_scripts` or `service_workers` may have limited functionality.
- **Complex Chrome APIs**: Only core APIs like `chrome.runtime.getURL` are currently shimmed.

## 📜 License

GNU GPLv3
