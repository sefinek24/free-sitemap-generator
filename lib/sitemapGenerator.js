import fs from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { axios, version } from '../services/axios.js';
import { escapeXml, normalizeUrl, calculatePriority } from '../utils/xml.js';
import { logInfo, logSuccess, logError, logWarning } from '../utils/chalk.js';

const IGNORED_PATTERNS = [
	'cdn-cgi', '?referrer=', '&referrer=', '/signin/v2/usernamerecovery', '/lifecycle/flows/signup', 'join?return_to=',
	'PHPSESSID=', 'JSESSIONID=', 'ASPSESSIONID', 'sessionid=', 'session_id=', '?sid=', '&sid=', 'phpsessid=',
];
const STATIC_EXTENSIONS = new Set([
	'.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif', '.tiff',
	'.css', '.js', '.mjs', '.map', '.json', '.txt', '.csv', '.xml',
	'.woff', '.woff2', '.ttf', '.eot', '.otf',
	'.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar', '.7z', '.gz', '.tar',
	'.mp3', '.mp4', '.webm', '.avi', '.mov', '.wav', '.ogg', '.flac',
]);
const BASE_DELAY = 14_000;
const DEFAULT_CONCURRENCY = 3;
const MAX_URLS = 50000;
const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;
const MAX_LOC_LENGTH = 2048;

const hasStaticExtension = pathname => {
	const lastDot = pathname.lastIndexOf('.');
	if (lastDot === -1) return false;
	return STATIC_EXTENSIONS.has(pathname.slice(lastDot).toLowerCase());
};

const shouldIncludeUrl = (url, baseUrl, baseOrigin, urlOrigin = null) => {
	if (!url.startsWith(baseUrl)) return false;
	if (IGNORED_PATTERNS.some(pattern => url.includes(pattern))) return false;
	try {
		const parsedUrl = new URL(url);
		if ((urlOrigin ?? parsedUrl.origin) !== baseOrigin) return false;
		return !hasStaticExtension(parsedUrl.pathname);
	} catch {
		return false;
	}
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const formatIso = date => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const nowIso = () => formatIso(new Date());

const fetchUrl = async (url, retries = 0) => {
	try {
		const res = await axios.get(url);
		if (res.status === 200) {
			return res;
		}
		logWarning(`Non-200 status code (${res.status}) for URL: ${url}. Skipping...`);
		return null;

	} catch (err) {
		if (err.response) {
			const statusCode = err.response.status;
			if (statusCode === 429) {
				const delayTime = BASE_DELAY * (2 ** retries);
				logWarning(`429: Rate limit hit for ${url}! Retrying in ${(delayTime / 1000).toFixed(2)}s... (Attempt ${retries + 1})`);
				await delay(delayTime);
				return fetchUrl(url, retries + 1);
			} else if (statusCode === 404) {
				logWarning(`404: Not Found - ${url}`);
				return null;
			}
			logError(`${statusCode}: Failed to fetch ${url}! Skipping...`);
			return null;

		}
		logError(`Failed to fetch ${url}. Unknown error: ${err.message}. Skipping...`);
		return null;

	}
};

const crawl = async (startUrl, baseUrl, baseOrigin, visitedUrls, concurrency = DEFAULT_CONCURRENCY) => {
	concurrency = Math.max(1, Math.floor(concurrency));

	const queued = new Set();
	const queue = [];

	const enqueue = url => {
		const normalized = normalizeUrl(url);
		if (!queued.has(normalized)) {
			queued.add(normalized);
			queue.push(normalized);
		}
	};

	enqueue(startUrl);

	const processUrl = async normalizedUrl => {
		const res = await fetchUrl(normalizedUrl);
		if (!res) return;

		let dom;
		try {
			dom = new JSDOM(res.data);
			const { document } = dom.window;

			const canonicalEl = document.querySelector('link[rel="canonical"]');
			if (canonicalEl) {
				try {
					const canonical = new URL(canonicalEl.getAttribute('href'), baseUrl);
					canonical.hash = '';
					if (canonical.href !== normalizedUrl && shouldIncludeUrl(canonical.href, baseUrl, baseOrigin, canonical.origin)) {
						logInfo(`GET ${normalizedUrl} (canonical → ${canonical.href}, skipped)`);
						enqueue(canonical.href);
						return;
					}
				} catch {
					// ...
				}
			}

			const links = new Set();
			for (const link of document.querySelectorAll('a[href]')) {
				try {
					const resolved = new URL(link.getAttribute('href'), baseUrl);
					resolved.hash = '';
					if (shouldIncludeUrl(resolved.href, baseUrl, baseOrigin, resolved.origin)) links.add(resolved.href);
				} catch {
					// ...
				}
			}

			const rawLastMod = res.headers['last-modified']
				?? document.querySelector('meta[property="article:modified_time"]')?.getAttribute('content')
				?? document.querySelector('meta[name="last-modified"]')?.getAttribute('content');

			let lastmod = null;
			if (rawLastMod) {
				const parsedLastMod = new Date(rawLastMod);
				if (!Number.isNaN(parsedLastMod.getTime())) lastmod = formatIso(parsedLastMod);
			}

			visitedUrls.set(normalizedUrl, {
				url: normalizedUrl,
				lastmod,
				priority: calculatePriority(normalizedUrl, baseUrl),
			});

			logInfo(`GET ${normalizedUrl} (${links.size} urls)`);

			for (const link of links) enqueue(link);
		} catch (err) {
			logError(`Failed to process ${normalizedUrl}: ${err.message}. Skipping...`);
		} finally {
			dom?.window?.close();
		}
	};

	await new Promise(resolve => {
		let active = 0;

		const dispatch = () => {
			if (queue.length === 0 && active === 0) {
				resolve();
				return;
			}

			while (active < concurrency && queue.length > 0) {
				const normalizedUrl = queue.shift();
				active++;
				processUrl(normalizedUrl).finally(() => {
					active--;
					dispatch();
				});
			}
		};

		dispatch();
	});
};

const buildUrlEntry = ({ url, lastmod, priority }) => `    <url>
        <loc>${escapeXml(url)}</loc>${lastmod ? `
        <lastmod>${lastmod}</lastmod>` : ''}
        <priority>${priority.toFixed(2)}</priority>
    </url>`;

const buildSitemapContent = urls => `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by https://github.com/sefinek/easy-sitemap-generator v${version} at ${nowIso()} -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9 http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">
${urls.map(buildUrlEntry).join('\n')}
</urlset>`;

const buildIndexContent = sitemapLocs => `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by https://github.com/sefinek/easy-sitemap-generator v${version} at ${nowIso()} -->
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9 http://www.sitemaps.org/schemas/sitemap/0.9/siteindex.xsd">
${sitemapLocs.map(({ loc, lastmod }) => `    <sitemap>
        <loc>${escapeXml(loc)}</loc>
        <lastmod>${lastmod}</lastmod>
    </sitemap>`).join('\n')}
</sitemapindex>`;

const chunkUrls = urls => {
	const shellBytes = Buffer.byteLength(buildSitemapContent([]), 'utf8');
	const chunks = [];
	let current = [];
	let currentBytes = shellBytes;

	for (const entry of urls) {
		const entryBytes = Buffer.byteLength(buildUrlEntry(entry), 'utf8') + 1; // +1 for the joining newline

		if (current.length > 0 && (current.length >= MAX_URLS || currentBytes + entryBytes > MAX_SITEMAP_BYTES)) {
			chunks.push(current);
			current = [];
			currentBytes = shellBytes;
		}

		current.push(entry);
		currentBytes += entryBytes;
	}

	if (current.length > 0) chunks.push(current);
	return chunks;
};

const generateSitemap = async (baseUrl, { destination = 'sitemap.xml', domain = null, concurrency = DEFAULT_CONCURRENCY } = {}) => {
	logInfo(`Starting crawl for base URL: ${baseUrl}`);

	const { origin: baseOrigin } = new URL(baseUrl);
	const targetOrigin = domain ? new URL(domain).origin : baseOrigin;
	const visitedUrls = new Map();
	await crawl(baseUrl, baseUrl, baseOrigin, visitedUrls, concurrency);

	logInfo(`Generating sitemap with ${visitedUrls.size} URLs...`);

	const urls = Array.from(visitedUrls.values())
		.filter(entry => {
			if (entry.url.length > MAX_LOC_LENGTH) {
				logWarning(`URL exceeds ${MAX_LOC_LENGTH} characters and was skipped: ${entry.url}`);
				return false;
			}
			return true;
		})
		.sort((a, b) => b.priority - a.priority)
		.map(entry => targetOrigin === baseOrigin ? entry : { ...entry, url: targetOrigin + entry.url.slice(baseOrigin.length) });

	const output = path.resolve(destination);
	const chunks = chunkUrls(urls);
	if (chunks.length <= 1) {
		const content = buildSitemapContent(urls);
		await fs.writeFile(output, content, 'utf8');
		logSuccess(`Sitemap generated at ${output}`);
		return content;
	}

	logWarning(`Found ${urls.length} URLs — exceeds the sitemap protocol limits (${MAX_URLS.toLocaleString()} URLs / 50MB). Splitting into ${chunks.length} sitemap files...`);

	const ext = path.extname(destination);
	const base = path.basename(destination, ext);
	const dir = path.dirname(output);
	const timestamp = nowIso();

	const sitemapLocs = await Promise.all(chunks.map(async (chunk, i) => {
		const part = i + 1;
		const filename = `${base}-${part}${ext}`;
		const filepath = path.join(dir, filename);
		const content = buildSitemapContent(chunk);
		await fs.writeFile(filepath, content, 'utf8');
		logSuccess(`Sitemap part ${part}/${chunks.length} written to ${filepath}`);
		return { loc: `${targetOrigin}/${filename}`, lastmod: timestamp };
	}));

	const indexContent = buildIndexContent(sitemapLocs);
	await fs.writeFile(output, indexContent, 'utf8');
	logSuccess(`Sitemap index written to ${output}`);

	return indexContent;
};

export { generateSitemap, version };
