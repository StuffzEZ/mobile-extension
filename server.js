const express = require('express');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const AdmZip = require('adm-zip');
const cheerio = require('cheerio');
const multer = require('multer');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const port = process.env.PORT || 3000;
const EXTENSIONS_DIR = path.join(__dirname, 'extensions');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

fs.ensureDirSync(EXTENSIONS_DIR);
fs.ensureDirSync(UPLOAD_DIR);

const upload = multer({ dest: UPLOAD_DIR });

// Store active sessions (extension scripts per target)
const sessions = new Map();

async function processExtensionFile(filePath) {
    const id = Date.now().toString();
    const extractPath = path.join(EXTENSIONS_DIR, id);

    const zip = new AdmZip(filePath);
    zip.extractAllTo(extractPath, true);

    const manifestPath = path.join(extractPath, 'manifest.json');
    if (!await fs.pathExists(manifestPath)) {
        await fs.remove(extractPath);
        throw new Error('Invalid extension: manifest.json missing');
    }
    
    const manifest = await fs.readJson(manifestPath);
    const contentScripts = manifest.content_scripts || [];
    
    return { id, extractPath, contentScripts };
}

async function downloadAndParseExtension(urlOrId) {
    let downloadUrl = urlOrId;
    let extensionId = '';

    if (/^[a-p]{32}$/.test(urlOrId)) {
        extensionId = urlOrId;
        downloadUrl = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=38.0&x=id%3D${extensionId}%26installsource%3Dondemand%26uc`;
    }

    const id = Date.now().toString();
    const outputPath = path.join(UPLOAD_DIR, `${id}.crx`);

    console.log(`Downloading: ${downloadUrl}`);
    const response = await axios({ method: 'get', url: downloadUrl, responseType: 'arraybuffer' });
    await fs.writeFile(outputPath, response.data);

    const extData = await processExtensionFile(outputPath);
    await fs.remove(outputPath);
    return extData;
}

app.use('/_extension_assets/:sessionId', (req, res, next) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).send('Session not found');
    express.static(session.extractPath)(req, res, next);
});

app.get('/', async (req, res) => {
    const { extension, url, list } = req.query;

    if (list) {
        return res.json([
            { name: 'Google', url: 'https://google.com' },
            { name: 'GitHub', url: 'https://github.com' }
        ]);
    }

    if (!extension || !url) {
        return res.send(`
            <style>
                body { font-family: -apple-system, sans-serif; padding: 20px; background: #fafafa; line-height: 1.5; }
                .container { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); }
                h1 { font-size: 24px; color: #333; margin-bottom: 20px; text-align: center; }
                section { margin-bottom: 25px; padding-bottom: 20px; border-bottom: 1px solid #eee; }
                section:last-child { border-bottom: none; }
                h2 { font-size: 16px; color: #666; margin-bottom: 10px; }
                input { width: 100%; padding: 12px; margin: 8px 0; border: 1px solid #ddd; border-radius: 6px; box-sizing: border-box; }
                button { width: 100%; padding: 12px; background: #007aff; color: white; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
                button:hover { background: #0063d1; }
                .file-input { border: 2px dashed #ddd; padding: 20px; text-align: center; border-radius: 6px; cursor: pointer; }
            </style>
            <div class="container">
                <h1>Mobile Extension Proxy</h1>
                
                <section>
                    <h2>Option 1: Chrome Web Store / URL</h2>
                    <form action="/proxy" method="GET">
                        <input type="text" name="extension" placeholder="Extension ID or CRX URL" required>
                        <input type="text" name="url" placeholder="Target Website (https://...)" required>
                        <button type="submit">Launch</button>
                    </form>
                </section>

                <section>
                    <h2>Option 2: Upload Extension (.zip or .crx)</h2>
                    <form action="/upload" method="POST" enctype="multipart/form-data">
                        <input type="file" name="extensionFile" accept=".zip,.crx" required>
                        <input type="text" name="url" placeholder="Target Website (https://...)" required>
                        <button type="submit">Upload & Launch</button>
                    </form>
                </section>
            </div>
        `);
    }
});

app.post('/upload', upload.single('extensionFile'), async (req, res) => {
    const { url } = req.body;
    const file = req.file;

    if (!file || !url) return res.status(400).send('Missing file or URL');

    try {
        const extData = await processExtensionFile(file.path);
        await fs.remove(file.path);

        const sessionId = extData.id;
        sessions.set(sessionId, extData);

        const targetUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
        res.redirect(`/view/${sessionId}/${targetUrl.href}`);
    } catch (error) {
        res.status(500).send(`Error: ${error.message}`);
    }
});

app.get('/proxy', async (req, res) => {
    const { extension, url } = req.query;
    try {
        const extData = await downloadAndParseExtension(extension);
        const sessionId = extData.id;
        sessions.set(sessionId, extData);

        const targetUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
        
        // Redirect to the proxied path
        res.redirect(`/view/${sessionId}/${targetUrl.href}`);
    } catch (error) {
        res.status(500).send(`Error: ${error.message}`);
    }
});

app.use('/view/:sessionId/*', (req, res, next) => {
    const { sessionId } = req.params;
    const targetUrl = req.params[0];
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).send('Session expired or not found');

    const target = new URL(targetUrl);
    
    return createProxyMiddleware({
        target: target.origin,
        changeOrigin: true,
        pathRewrite: {
            [`^/view/${sessionId}/${targetUrl}`]: '',
        },
        selfHandleResponse: true,
        onProxyRes: async (proxyRes, req, res) => {
            let body = [];
            proxyRes.on('data', (chunk) => body.push(chunk));
            proxyRes.on('end', async () => {
                const buffer = Buffer.concat(body);
                const contentType = proxyRes.headers['content-type'] || '';

                if (contentType.includes('text/html')) {
                    const html = buffer.toString('utf8');
                    const $ = cheerio.load(html);

                    // Inject content scripts
                    session.contentScripts.forEach(script => {
                        // Check matches (simplified)
                        if (script.js) {
                            script.js.forEach(jsFile => {
                                $('head').append(`<script src="/_extension_assets/${sessionId}/${jsFile}"></script>`);
                            });
                        }
                        if (script.css) {
                            script.css.forEach(cssFile => {
                                $('head').append(`<link rel="stylesheet" href="/_extension_assets/${sessionId}/${cssFile}">`);
                            });
                        }
                    });

                    // Add a small helper to mock some chrome APIs and handle navigation
                    $('head').prepend(`
                        <script>
                            // Mock Chrome APIs
                            window.chrome = window.chrome || {};
                            window.chrome.runtime = window.chrome.runtime || {
                                getURL: (path) => "/_extension_assets/${sessionId}/" + path,
                                sendMessage: () => {},
                                onMessage: { addListener: () => {} }
                            };
                            window.chrome.extension = window.chrome.extension || { getURL: window.chrome.runtime.getURL };

                            // Intercept navigation to stay within proxy
                            document.addEventListener('click', (e) => {
                                const link = e.target.closest('a');
                                if (link && link.href && link.href.startsWith(window.location.origin)) {
                                    // Already local or absolute to same origin
                                } else if (link && link.href) {
                                    e.preventDefault();
                                    const targetUrl = new URL(link.href);
                                    window.location.href = "/view/${sessionId}/" + targetUrl.href;
                                }
                            });

                            // Intercept form submissions
                            document.addEventListener('submit', (e) => {
                                const form = e.target;
                                const action = form.action || window.location.href;
                                if (!action.includes('/view/${sessionId}/')) {
                                    const targetUrl = new URL(action, window.location.href);
                                    form.action = "/view/${sessionId}/" + targetUrl.href;
                                }
                            });
                        </script>
                    `);

                    res.setHeader('content-type', 'text/html');
                    res.send($.html());
                } else {
                    res.writeHead(proxyRes.statusCode, proxyRes.headers);
                    res.end(buffer);
                }
            });
        },
        onError: (err, req, res) => {
            res.status(500).send('Proxy Error: ' + err.message);
        }
    })(req, res, next);
});

app.listen(port, () => {
    console.log(`Lightweight Extension Proxy running at http://localhost:${port}`);
});
