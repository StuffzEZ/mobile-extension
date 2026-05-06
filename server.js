const express = require('express');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const AdmZip = require('adm-zip');
const cheerio = require('cheerio');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const port = process.env.PORT || 3000;
const CACHE_DIR = path.join(__dirname, 'extension_cache');

fs.ensureDirSync(CACHE_DIR);

// GitHub repository configuration
const GITHUB_REPO = 'LeakHW/Extension';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}`;

// In-memory extension data
let extensionData = {
    manifest: null,
    files: new Map(), // path -> content
    version: null,
    lastFetch: null
};

// Cache duration: 5 minutes
const CACHE_DURATION = 5 * 60 * 1000;

/**
 * Fetch the latest release tag from GitHub
 */
async function getLatestReleaseTag() {
    try {
        const response = await axios.get(`${GITHUB_API}/releases/latest`, {
            headers: { 'Accept': 'application/vnd.github.v3+json' }
        });
        return response.data.tag_name;
    } catch (error) {
        console.log('No releases found, fetching latest commit from main branch');
        // Fallback to main branch if no releases
        const response = await axios.get(`${GITHUB_API}/branches/main`, {
            headers: { 'Accept': 'application/vnd.github.v3+json' }
        });
        return response.data.commit.sha;
    }
}

/**
 * Download and extract extension from GitHub
 */
async function fetchExtensionFromGitHub() {
    const now = Date.now();
    
    // Return cached data if still fresh
    if (extensionData.lastFetch && (now - extensionData.lastFetch < CACHE_DURATION)) {
        console.log('Using cached extension data');
        return extensionData;
    }

    console.log('Fetching latest extension from GitHub...');
    
    try {
        const tag = await getLatestReleaseTag();
        console.log(`Latest version: ${tag}`);
        
        // Download the repository archive
        const archiveUrl = `https://github.com/${GITHUB_REPO}/archive/refs/tags/${tag}.zip`;
        let downloadUrl = archiveUrl;
        
        // Try release first, fallback to branch
        try {
            await axios.head(archiveUrl);
        } catch {
            downloadUrl = `https://github.com/${GITHUB_REPO}/archive/refs/heads/main.zip`;
            console.log('Using main branch instead of release');
        }
        
        const response = await axios({
            method: 'get',
            url: downloadUrl,
            responseType: 'arraybuffer'
        });
        
        const zipPath = path.join(CACHE_DIR, 'extension.zip');
        await fs.writeFile(zipPath, response.data);
        
        // Extract zip
        const zip = new AdmZip(zipPath);
        const extractPath = path.join(CACHE_DIR, 'extracted');
        await fs.remove(extractPath);
        zip.extractAllTo(extractPath, true);
        
        // Find the src directory (it might be nested in a folder like Extension-tag/src)
        const dirs = await fs.readdir(extractPath);
        let srcPath = null;
        
        for (const dir of dirs) {
            const potentialSrc = path.join(extractPath, dir, 'src');
            if (await fs.pathExists(potentialSrc)) {
                srcPath = potentialSrc;
                break;
            }
        }
        
        if (!srcPath) {
            throw new Error('src directory not found in repository');
        }
        
        console.log(`Found src directory at: ${srcPath}`);
        
        // Read manifest.json
        const manifestPath = path.join(srcPath, 'manifest.json');
        if (!await fs.pathExists(manifestPath)) {
            throw new Error('manifest.json not found in src directory');
        }
        
        const manifest = await fs.readJson(manifestPath);
        console.log(`Loaded manifest for: ${manifest.name} v${manifest.version}`);
        
        // Load all files into memory
        const files = new Map();
        
        async function loadFilesRecursively(dir, baseDir) {
            const items = await fs.readdir(dir);
            
            for (const item of items) {
                const fullPath = path.join(dir, item);
                const stat = await fs.stat(fullPath);
                
                if (stat.isDirectory()) {
                    await loadFilesRecursively(fullPath, baseDir);
                } else {
                    const relativePath = path.relative(baseDir, fullPath);
                    const content = await fs.readFile(fullPath);
                    files.set(relativePath, content);
                    console.log(`Loaded: ${relativePath}`);
                }
            }
        }
        
        await loadFilesRecursively(srcPath, srcPath);
        
        // Update in-memory cache
        extensionData = {
            manifest,
            files,
            version: tag,
            lastFetch: now
        };
        
        console.log(`Extension cached: ${files.size} files loaded`);
        
        // Clean up
        await fs.remove(zipPath);
        await fs.remove(extractPath);
        
        return extensionData;
        
    } catch (error) {
        console.error('Error fetching extension:', error.message);
        
        // If cache exists but stale, use it anyway
        if (extensionData.manifest) {
            console.log('Using stale cache due to fetch error');
            return extensionData;
        }
        
        throw error;
    }
}

/**
 * Serve extension assets from memory
 */
app.get('/_extension/*', async (req, res) => {
    try {
        const ext = await fetchExtensionFromGitHub();
        const filePath = req.params[0]; // Everything after /_extension/
        
        const content = ext.files.get(filePath);
        
        if (!content) {
            return res.status(404).send('File not found');
        }
        
        // Set appropriate content type
        const extname = path.extname(filePath).toLowerCase();
        const contentTypes = {
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.html': 'text/html',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.svg': 'image/svg+xml',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2'
        };
        
        res.setHeader('Content-Type', contentTypes[extname] || 'application/octet-stream');
        res.send(content);
        
    } catch (error) {
        res.status(500).send(`Error serving extension file: ${error.message}`);
    }
});

/**
 * Home page - simple URL input
 */
app.get('/', async (req, res) => {
    const { url } = req.query;
    
    if (!url) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Mobile Extension Proxy</title>
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body { 
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        min-height: 100vh;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        padding: 20px;
                    }
                    .container {
                        background: white;
                        border-radius: 20px;
                        padding: 40px;
                        max-width: 500px;
                        width: 100%;
                        box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                    }
                    h1 {
                        font-size: 28px;
                        color: #333;
                        margin-bottom: 10px;
                        text-align: center;
                    }
                    .subtitle {
                        text-align: center;
                        color: #666;
                        margin-bottom: 30px;
                        font-size: 14px;
                    }
                    .info {
                        background: #f0f4ff;
                        padding: 15px;
                        border-radius: 10px;
                        margin-bottom: 25px;
                        border-left: 4px solid #667eea;
                    }
                    .info-title {
                        font-weight: 600;
                        color: #667eea;
                        margin-bottom: 5px;
                    }
                    .info-text {
                        font-size: 13px;
                        color: #555;
                        line-height: 1.5;
                    }
                    form {
                        display: flex;
                        flex-direction: column;
                        gap: 15px;
                    }
                    input {
                        padding: 15px;
                        border: 2px solid #e0e0e0;
                        border-radius: 10px;
                        font-size: 16px;
                        transition: border-color 0.3s;
                    }
                    input:focus {
                        outline: none;
                        border-color: #667eea;
                    }
                    button {
                        padding: 15px;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                        border: none;
                        border-radius: 10px;
                        font-size: 16px;
                        font-weight: 600;
                        cursor: pointer;
                        transition: transform 0.2s, box-shadow 0.2s;
                    }
                    button:hover {
                        transform: translateY(-2px);
                        box-shadow: 0 10px 20px rgba(102, 126, 234, 0.4);
                    }
                    button:active {
                        transform: translateY(0);
                    }
                    .features {
                        margin-top: 30px;
                        padding-top: 30px;
                        border-top: 1px solid #e0e0e0;
                    }
                    .feature {
                        display: flex;
                        align-items: start;
                        gap: 10px;
                        margin-bottom: 15px;
                        font-size: 14px;
                        color: #555;
                    }
                    .feature-icon {
                        color: #667eea;
                        font-weight: bold;
                        font-size: 18px;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🚀 Mobile Extension Proxy</h1>
                    <p class="subtitle">Use Chrome Extensions on mobile browsers</p>
                    
                    <div class="info">
                        <div class="info-title">📦 Auto-loaded Extension</div>
                        <div class="info-text">
                            Latest version from <strong>github.com/LeakHW/Extension</strong> 
                            is automatically fetched and injected into every page you visit.
                        </div>
                    </div>
                    
                    <form action="/" method="GET">
                        <input 
                            type="url" 
                            name="url" 
                            placeholder="Enter website URL (e.g., https://example.com)" 
                            required 
                            autocomplete="off"
                            pattern="https?://.+"
                            title="Please enter a valid URL starting with http:// or https://"
                        >
                        <button type="submit">🌐 Browse with Extension</button>
                    </form>
                    
                    <div class="features">
                        <div class="feature">
                            <span class="feature-icon">✨</span>
                            <span>Zero setup - extension loaded automatically</span>
                        </div>
                        <div class="feature">
                            <span class="feature-icon">🔄</span>
                            <span>Always uses the latest release from GitHub</span>
                        </div>
                        <div class="feature">
                            <span class="feature-icon">📱</span>
                            <span>Works on any mobile browser</span>
                        </div>
                        <div class="feature">
                            <span class="feature-icon">⚡</span>
                            <span>Lightning-fast in-memory streaming</span>
                        </div>
                    </div>
                </div>
            </body>
            </html>
        `);
    }
    
    // Redirect to proxy view
    const targetUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
    res.redirect(`/proxy/${encodeURIComponent(targetUrl.href)}`);
});

/**
 * Proxy middleware for browsing websites with extension injected
 */
app.use('/proxy/:targetUrl(*)', async (req, res, next) => {
    const targetUrl = decodeURIComponent(req.params.targetUrl);
    
    try {
        // Ensure extension is loaded
        const ext = await fetchExtensionFromGitHub();
        
        const target = new URL(targetUrl);
        const remainingPath = req.url.replace(`/proxy/${encodeURIComponent(targetUrl)}`, '');
        
        return createProxyMiddleware({
            target: target.origin,
            changeOrigin: true,
            pathRewrite: () => {
                return target.pathname + target.search + (remainingPath || '');
            },
            selfHandleResponse: true,
            onProxyRes: async (proxyRes, req, res) => {
                let body = [];
                proxyRes.on('data', (chunk) => body.push(chunk));
                proxyRes.on('end', async () => {
                    const buffer = Buffer.concat(body);
                    const contentType = proxyRes.headers['content-type'] || '';

                    if (contentType.includes('text/html')) {
                        try {
                            const html = buffer.toString('utf8');
                            const $ = cheerio.load(html);

                            // Inject content scripts from manifest
                            if (ext.manifest.content_scripts) {
                                ext.manifest.content_scripts.forEach(script => {
                                    // Check if this script should run on this URL
                                    const matches = script.matches || [];
                                    const shouldInject = matches.some(pattern => {
                                        // Simple pattern matching (you can enhance this)
                                        const regex = new RegExp(
                                            pattern
                                                .replace(/\*/g, '.*')
                                                .replace(/\./g, '\\.')
                                        );
                                        return regex.test(targetUrl);
                                    }) || matches.includes('<all_urls>');

                                    if (shouldInject) {
                                        // Inject CSS files
                                        if (script.css) {
                                            script.css.forEach(cssFile => {
                                                $('head').append(
                                                    `<link rel="stylesheet" href="/_extension/${cssFile}">`
                                                );
                                            });
                                        }

                                        // Inject JS files
                                        if (script.js) {
                                            script.js.forEach(jsFile => {
                                                $('head').append(
                                                    `<script src="/_extension/${jsFile}"></script>`
                                                );
                                            });
                                        }
                                    }
                                });
                            }

                            // Add Chrome API shim and navigation interceptor
                            $('head').prepend(`
                                <script>
                                    // Mock Chrome Extension APIs
                                    window.chrome = window.chrome || {};
                                    window.chrome.runtime = window.chrome.runtime || {
                                        getURL: (path) => "/_extension/" + path,
                                        sendMessage: function() { console.log('chrome.runtime.sendMessage called'); },
                                        onMessage: { 
                                            addListener: function() { console.log('chrome.runtime.onMessage.addListener called'); } 
                                        },
                                        id: 'mobile-proxy-extension'
                                    };
                                    window.chrome.extension = window.chrome.extension || { 
                                        getURL: window.chrome.runtime.getURL 
                                    };
                                    window.chrome.storage = window.chrome.storage || {
                                        local: {
                                            get: (keys, callback) => callback({}),
                                            set: (items, callback) => callback && callback(),
                                            remove: (keys, callback) => callback && callback(),
                                            clear: (callback) => callback && callback()
                                        },
                                        sync: {
                                            get: (keys, callback) => callback({}),
                                            set: (items, callback) => callback && callback(),
                                            remove: (keys, callback) => callback && callback(),
                                            clear: (callback) => callback && callback()
                                        }
                                    };

                                    // Intercept navigation to keep user in proxy
                                    const PROXY_PREFIX = '/proxy/${encodeURIComponent(targetUrl)}';
                                    
                                    function rewriteUrl(url) {
                                        try {
                                            const targetUrl = new URL(url, window.location.href);
                                            if (targetUrl.origin === window.location.origin && url.startsWith('/_extension/')) {
                                                return url; // Extension resource
                                            }
                                            return '/proxy/' + encodeURIComponent(targetUrl.href);
                                        } catch {
                                            return url;
                                        }
                                    }

                                    // Intercept link clicks
                                    document.addEventListener('click', (e) => {
                                        const link = e.target.closest('a');
                                        if (link && link.href && !link.href.startsWith('/_extension/')) {
                                            e.preventDefault();
                                            window.location.href = rewriteUrl(link.href);
                                        }
                                    }, true);

                                    // Intercept form submissions
                                    document.addEventListener('submit', (e) => {
                                        const form = e.target;
                                        const action = form.action || window.location.href;
                                        if (!action.startsWith('/_extension/')) {
                                            e.preventDefault();
                                            const formData = new FormData(form);
                                            const method = form.method.toUpperCase();
                                            const targetUrl = rewriteUrl(action);
                                            
                                            if (method === 'GET') {
                                                const params = new URLSearchParams(formData);
                                                window.location.href = targetUrl + '?' + params.toString();
                                            } else {
                                                fetch(targetUrl, {
                                                    method: method,
                                                    body: formData
                                                }).then(r => r.text()).then(html => {
                                                    document.open();
                                                    document.write(html);
                                                    document.close();
                                                });
                                            }
                                        }
                                    }, true);
                                </script>
                            `);

                            res.setHeader('content-type', 'text/html; charset=utf-8');
                            res.send($.html());
                        } catch (error) {
                            console.error('Error processing HTML:', error);
                            res.writeHead(proxyRes.statusCode, proxyRes.headers);
                            res.end(buffer);
                        }
                    } else {
                        // Pass through non-HTML content
                        res.writeHead(proxyRes.statusCode, proxyRes.headers);
                        res.end(buffer);
                    }
                });
            },
            onError: (err, req, res) => {
                console.error('Proxy error:', err);
                res.status(500).send(`
                    <h1>Proxy Error</h1>
                    <p>${err.message}</p>
                    <p><a href="/">← Go Back</a></p>
                `);
            }
        })(req, res, next);
        
    } catch (error) {
        res.status(500).send(`
            <h1>Extension Load Error</h1>
            <p>${error.message}</p>
            <p><a href="/">← Go Back</a></p>
        `);
    }
});

// Start server and pre-fetch extension
app.listen(port, async () => {
    console.log(`🚀 Mobile Extension Proxy running at http://localhost:${port}`);
    console.log(`📦 Extension source: github.com/${GITHUB_REPO}`);
    
    // Pre-load extension on startup
    try {
        await fetchExtensionFromGitHub();
        console.log('✅ Extension pre-loaded successfully');
    } catch (error) {
        console.error('⚠️  Failed to pre-load extension:', error.message);
        console.log('   Extension will be fetched on first request');
    }
});